#!/usr/bin/env node
// pr-drift-check.mjs — review follow-up 的 push 前门禁:检测 PR 是否已陷入 review 循环 / 范围漂移。
//
// 背景(2026-08-02 实踩,10 个 PR 的完整数据):当晚合并的 6 个 PR 全部 ≤544 插入 / ≤5 commit /
// ≤1 个 address-review commit / 0.6-2.6h 收口;卡住的 4 个是 1416-3789 插入 / 14-23 commit /
// 9-18 个 address-review commit / 7.3-14.4h 未完。commit 间隔稳定在 28±5 分钟 = CI 一轮 +
// bot review 一轮的时间,即 push→等bot→立刻改→push 的闭环振荡了十几个小时。
//
// SKILL.md 里「合批纪律失效信号」原本的判据是"一小时内 ≥3 次 push",而 28 分钟节奏一小时只有
// 2 次——恰好卡在阈值之下,规则永远不触发。本脚本改用累计 address-review commit 数与规模漂移率,
// 这两个指标在昨晚的数据上能把 6 个健康 PR 与 4 个病态 PR 完全分开。
//
// 用法: node pr-drift-check.mjs <PR号> [owner/repo]
//   在目标仓库(或其 worktree)内运行;repo 省略时从 gh 推断。
// 输出: 第一行是机器可读结论 PASS / WARN: <摘要> / STOP: <摘要>,之后是逐项明细与 ACTION。
// 退出码: 0=PASS, 0=WARN, 2=STOP(便于 shell 里 `|| exit` 硬拦)。

import { execFileSync } from 'node:child_process'

const PR = process.argv[2]
if (!PR || !/^\d+$/.test(PR)) {
  console.error('用法: node pr-drift-check.mjs <PR号> [owner/repo]')
  process.exit(1)
}

// ── 阈值(2026-08-02 按 10 个 PR 校准;2026-08-04 收紧 addr 档) ─────────
// 2026-08-04 复盘:#1581 修到 8 轮才撞 STOP,415 行正题已泵成 1097 行,连同两个衍生 PR
// 共 +2504 行全部关闭重做;#1636 4 轮 +182% 勉强合并但主体已漂。旧阈值(STOP≥8)等于
// 允许病态循环跑满七轮才拦。新政策(SKILL.md「Bot 复审循环收敛」):3 轮是硬上限,
// 第 4 个 address-review commit 出现即 STOP → hb-register --pause 冻结 → 飞书问 Chris。
const T = {
  addrWarn: 3,        // 健康 PR 实测 ≤1 个;3 = 已到上限,本轮就是最后一轮
  addrStop: 4,        // 超过 3 轮硬上限 → 冻结,不再修
  growthWarn: 0.5,    // review 阶段插入行净增长率
  growthStop: 1.5,    // #1376 = +621%, #1371 = +124%
  growthMinAbs: 200,  // 小基数的百分比无意义:净增不到这么多行就不判(#1390 155行PR涨70%属正常)
  // 注:[2] 漂移刻意保留**总行数**口径(含测试)——review 阶段无论长出什么都算漂移信号,
  // #1635 的 +481% 里大半是给不该存在的重试体系写的测试,按总数算才拦得住。
  // [4] 绝对规模改为**非测试代码**口径(2026-08-04)。原先用 gh 的 additions 总数,
  // 而 #1636 总 1071 行里 779 行是测试、实现面仅 292 行;#1635 总 1697 / 实现 453。
  // 用总行数既会把"实现小、回归测试厚"的健康 PR 误判成巨物,又让真正的大实现藏在测试
  // 噪音里。阈值与入口闸门 pr-size-gate.mjs(STOP 300)衔接:开 PR 时 300 要问人,
  // 进 review 后允许长到 800 才冻结。
  filesWarn: 15,
  filesStop: 25,
  insWarn: 400,
  insStop: 800,
  filesWarnIns: 250,  // 文件多但行数少通常是重命名/i18n 铺开,不是复杂度
  filesStopIns: 500,
}

// 测试/快照文件不计入规模判据:体量大但几乎不引发 review 循环。
const TEST_RE = /(^|\/)(__tests__|__snapshots__|test|tests|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.snap$/

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()

// 按视觉宽度换行(CJK 算 2 列),优先在中文标点或空格后断,避免把词和路径切断。
const wrap = (text, width = 80) => {
  const w = (ch) => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1)
  const lines = []
  let cur = ''
  let cols = 0
  let lastBreak = -1
  for (const ch of text) {
    cur += ch
    cols += w(ch)
    if (/[,。;:、)】」…\s]/.test(ch)) lastBreak = cur.length
    if (cols >= width) {
      const cut = lastBreak > width * 0.5 ? lastBreak : cur.length
      lines.push(cur.slice(0, cut).trimEnd())
      cur = cur.slice(cut)
      cols = [...cur].reduce((a, c) => a + w(c), 0)
      lastBreak = -1
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd())
  return lines
}

const trySh = (cmd, args) => {
  try {
    return sh(cmd, args)
  } catch {
    return null
  }
}

let repo = process.argv[3]
if (!repo) {
  repo = trySh('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  if (!repo) {
    console.log('STOP: 无法确定 owner/repo(不在 git 仓库内或 gh 未认证),请显式传入')
    process.exit(2)
  }
}

// ── 拉 PR 数据 ────────────────────────────────────────────────────
let pr
try {
  pr = JSON.parse(
    sh('gh', [
      'pr', 'view', PR, '-R', repo, '--json',
      'title,additions,deletions,changedFiles,commits,state,isDraft,headRefName,files',
    ]),
  )
} catch (e) {
  console.log(`STOP: 读取 PR #${PR} 失败 — ${String(e.stderr || e.message).split('\n')[0]}`)
  process.exit(2)
}

const ADDR_RE = /address review|address feedback|address comments|fix review/i
const commits = pr.commits || []
const addrCommits = commits.filter((c) => ADDR_RE.test(c.messageHeadline || ''))
const findings = []
let worst = 'PASS'
const bump = (level) => {
  if (level === 'STOP') worst = 'STOP'
  else if (level === 'WARN' && worst !== 'STOP') worst = 'WARN'
}

// ── [1] review 循环强度 ───────────────────────────────────────────
{
  const n = addrCommits.length
  const level = n >= T.addrStop ? 'STOP' : n >= T.addrWarn ? 'WARN' : 'PASS'
  bump(level)
  findings.push({
    id: '1',
    name: 'review 循环强度',
    level,
    detail: `${n} 个 address-review commit / 共 ${commits.length} 个 commit（WARN≥${T.addrWarn} STOP≥${T.addrStop}）`,
    action:
      level === 'PASS'
        ? null
        : level === 'STOP'
          ? `已 ${n} 轮,超过 3 轮硬上限(SKILL.md「Bot 复审循环收敛」)。不要再修任何意见:执行 ` +
            `hb-register.mjs <owner/repo> ${PR} --pause "review 超轮数" 冻结跟进,飞书报 Chris ` +
            `三选一(继续修/缩回正题重发/关闭),他裁决前一行码不改。`
          : `已 ${n} 轮,本轮就是最后一轮(3 轮硬上限)。把当前全部未解决意见一次拉全、按三分法归类` +
            `(修/答/推——加固与邻域扩展类默认外推 issue,不修)、一批改完一次 push。若同一底层逻辑被` +
            `连续多轮不同 finding 触碰,说明抽象本身不对——那是 --pause + 问 Chris 的信号,不是继续补丁的信号。`,
  })
}

// ── [2] review 阶段规模漂移 ───────────────────────────────────────
// 基线 = 第一个 address-review commit 的父提交(即进入 review 循环前的最后状态)。
// 每个 commit 都对它自己的 merge-base 算 diff,这样 merge 上游带进来的代码不会污染统计。
{
  const sizeAt = (ref) => {
    const mb = trySh('git', ['merge-base', 'upstream/main', ref]) ||
               trySh('git', ['merge-base', 'origin/main', ref]) ||
               trySh('git', ['merge-base', 'upstream/HEAD', ref])
    if (!mb) return null
    const st = trySh('git', ['diff', '--shortstat', `${mb}...${ref}`])
    if (!st) return null
    const ins = Number((st.match(/(\d+) insertion/) || [])[1] || 0)
    const files = Number((st.match(/(\d+) file/) || [])[1] || 0)
    return { ins, files }
  }

  if (addrCommits.length === 0) {
    findings.push({
      id: '2',
      name: 'review 阶段规模漂移',
      level: 'N/A',
      detail: '尚无 address-review commit,还没进入 review 循环',
      action: null,
    })
  } else {
    // 当前形态默认取本地 HEAD(push 前门禁要检查"即将推的东西");若本地不在该 PR 的分支上
    // (HEAD 不含 PR 尾 commit),回退到 PR 远端 head,这样在任何目录都能查。
    const prTip = commits.length ? commits[commits.length - 1].oid : null
    const onBranch = prTip && trySh('git', ['merge-base', '--is-ancestor', prTip, 'HEAD']) !== null
    const tipRef = onBranch ? 'HEAD' : prTip
    if (!onBranch && prTip) console.error(`（提示:本地 HEAD 不含 PR 尾 commit,规模按远端 head ${prTip.slice(0, 7)} 计算）`)

    const firstAddr = addrCommits[0].oid
    const baseline = sizeAt(`${firstAddr}~1`)
    const current = tipRef ? sizeAt(tipRef) : null
    if (!baseline || !current || baseline.ins === 0) {
      findings.push({
        id: '2',
        name: 'review 阶段规模漂移',
        level: 'N/A',
        detail: '本地缺少 upstream/main 或 PR 提交,无法计算(先 git fetch upstream)',
        action: null,
      })
    } else {
      const growth = (current.ins - baseline.ins) / baseline.ins
      const absGrowth = current.ins - baseline.ins
      const level =
        absGrowth < T.growthMinAbs
          ? 'PASS'
          : growth >= T.growthStop
            ? 'STOP'
            : growth >= T.growthWarn
              ? 'WARN'
              : 'PASS'
      bump(level)
      const pct = `${growth >= 0 ? '+' : ''}${(growth * 100).toFixed(0)}%`
      findings.push({
        id: '2',
        name: 'review 阶段规模漂移',
        level,
        detail:
          `进 review 前 ${baseline.ins} 插入/${baseline.files} 文件 → 现在 ${current.ins} 插入/` +
          `${current.files} 文件,净增 ${pct}（WARN≥+${T.growthWarn * 100}% STOP≥+${T.growthStop * 100}%）`,
        action:
          level === 'PASS'
            ? null
            : `PR 在 review 阶段长了 ${pct},主体可能已经不是它标题声称的东西了(2026-08-02 #1376 实踩:` +
              `"换 worktree 基底"的 244 行修复长到 1759 行,其中大半在手写跨平台进程树终止)。` +
              `现在做两件事:① 跑 \`git diff <base>...HEAD --stat\` 看改动最多的文件,对照 PR 标题与` +
              `意图契约,回答"这些新增代码属于原目标吗";② 不属于的整块剥离另开 PR,属于但属于有成熟` +
              `解法的通用问题(进程管理/重试/并发原语)先找现成方案,别在本 PR 里手写试错。`,
      })
    }
  }
}

// ── [3] 已回应但未 resolve 的线程 ─────────────────────────────────
// 昨晚 4 个 PR 全部因此被 auto-review 跳过;#1371 回应了却没点 resolve,白卡 5 小时。
{
  const me = trySh('gh', ['api', 'user', '--jq', '.login'])
  const [owner, name] = repo.split('/')
  const q = `{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${PR}){reviewThreads(last:100){nodes{isResolved isOutdated path line comments(last:1){nodes{author{login}}}}}}}}`
  const raw = trySh('gh', ['api', 'graphql', '-f', `query=${q}`])
  if (!raw || !me) {
    findings.push({
      id: '3',
      name: '已回应未 resolve 线程',
      level: 'N/A',
      detail: 'GraphQL 或当前用户查询失败,请手工核对 unresolved 线程',
      action: null,
    })
  } else {
    const nodes = JSON.parse(raw).data.repository.pullRequest.reviewThreads.nodes || []
    const active = nodes.filter((t) => !t.isResolved && !t.isOutdated)
    const mine = active.filter((t) => {
      const last = (t.comments.nodes || []).slice(-1)[0]
      return last && last.author && last.author.login === me
    })
    const level = mine.length > 0 ? 'STOP' : 'PASS'
    bump(level)
    findings.push({
      id: '3',
      name: '已回应未 resolve 线程',
      level,
      detail:
        mine.length > 0
          ? `${mine.length} 条你已回复但未 resolve:${mine.map((t) => `${t.path}:${t.line ?? '-'}`).join(', ')}` +
            `（另有 ${active.length - mine.length} 条待你回应）`
          : `0 条（当前未 resolve 共 ${active.length} 条,均等你回应）`,
      action:
        level === 'PASS'
          ? null
          : `这些线程你已经回复过,但没点 Resolve conversation。只要还有一条未 resolve,auto-review ` +
            `就会跳过整个 PR——不审查、不合并,而且不会有人提醒你(2026-08-02 #1371 实踩:19:42 完整` +
            `回应,忘了 resolve,白卡 5 小时)。立刻逐条 resolve;若某条是刻意留给放行人裁决的,在 PR ` +
            `描述里显式列出"哪些线程等谁裁决",别让它静静堵着。`,
    })
  }
}

// ── [4] 绝对规模闸门(非测试口径) ──────────────────────────────────
{
  const files = pr.files || []
  let prodIns = 0, prodFiles = 0, testIns = 0
  for (const f of files) {
    const ins = f.additions || 0
    if (TEST_RE.test(f.path || '')) testIns += ins
    else { prodIns += ins; prodFiles += 1 }
  }
  // files 拿不到时退回总数,并在 detail 里注明口径已降级
  const degraded = files.length === 0
  const i = degraded ? pr.additions : prodIns
  const f = degraded ? pr.changedFiles : prodFiles
  const level =
    i >= T.insStop || (f >= T.filesStop && i >= T.filesStopIns)
      ? 'STOP'
      : i >= T.insWarn || (f >= T.filesWarn && i >= T.filesWarnIns)
        ? 'WARN'
        : 'PASS'
  bump(level)
  findings.push({
    id: '4',
    name: '绝对规模(非测试)',
    level,
    detail: degraded
      ? `+${i} / ${f} 文件〔口径降级:未取到 files,按总数判〕（WARN ${T.insWarn} · STOP ${T.insStop}）`
      : `非测试 +${prodIns} / ${prodFiles} 文件,另有测试 +${testIns}（WARN ${T.insWarn}行或${T.filesWarn}文件且${T.filesWarnIns}行 · STOP ${T.insStop}行或${T.filesStop}文件且${T.filesStopIns}行）`,
    action:
      level === 'PASS'
        ? null
        : `这个实现体量在本机数据上从未按时收口过(2026-08-04:非测试 292 行跑了 4 轮 review,` +
          `450 行的振荡 8 轮后废弃重做;54 行的一轮就合并)。核对一件事:PR 描述里的"目标"能不能` +
          `用一句话说完,中间不用"同时/并/另外/顺便"连接?说不完就是多个目标捆在一起。能独立使用、` +
          `独立验证、独立合并的部分立刻剥离另开 PR;确实拆不开的,在描述里逐项论证为什么,并按` +
          `「怎么问」把拆不拆这件事交给 Chris——拆分是产品交付决定,不自行裁决。`,
  })
}

// ── [5] 工具链容量信号 ───────────────────────────────────────────
{
  const TOOL_RE = /heap|out of memory|oom|max-old-space|堆上限|推断开销|typecheck.*(上限|超时)/i
  const hits = commits.filter((c) => TOOL_RE.test(c.messageHeadline || ''))
  // 规则语义是"PR 大到撑爆工具链",不是"PR 在修工具链"。小 PR 里的 heap 调整就是正常的
  // CI 维护工作(#1403 全文 4 行、#1401 389 行),不该报。
  const bigEnough =
    pr.additions >= T.insWarn || (pr.changedFiles >= T.filesWarn && pr.additions >= T.filesWarnIns)
  const level = hits.length > 0 && bigEnough ? 'WARN' : 'PASS'
  bump(level)
  findings.push({
    id: '5',
    name: '工具链容量信号',
    level,
    detail:
      hits.length === 0
        ? '无'
        : bigEnough
          ? `${hits.length} 个 commit 在调工具链容量:${hits.map((c) => c.messageHeadline.slice(0, 44)).join(' / ')}`
          : `${hits.length} 个 commit 涉及工具链容量,但本 PR 规模不大 — 视为正常的 CI 维护,不计入`,
    action:
      level === 'PASS'
        ? null
        : `PR 大到把 typecheck / CI 内存撑爆,是"该拆了"的信号,不是"该加内存了"的信号` +
          `(2026-08-02 #1371 实踩:两个 commit 分别降推断开销、抬 heap 上限,同晚还催生了仓库级把 ` +
          `CI heap 提到 8GB 的 #1403)。加容量可以做,但同时必须回答规模问题。`,
  })
}

// ── 输出 ─────────────────────────────────────────────────────────
const stops = findings.filter((f) => f.level === 'STOP')
const warns = findings.filter((f) => f.level === 'WARN')
const head =
  worst === 'STOP'
    ? `STOP: ${stops.map((f) => f.name).join(' / ')} 超阈值`
    : worst === 'WARN'
      ? `WARN: ${warns.map((f) => f.name).join(' / ')} 接近阈值`
      : 'PASS'

console.log(head)
console.log('')
console.log(`PR #${PR} ${repo}${pr.isDraft ? ' [draft]' : ''} — ${pr.title}`)
console.log('')
for (const f of findings) {
  const tag = { PASS: ' PASS', WARN: ' WARN', STOP: ' STOP', 'N/A': '  N/A' }[f.level]
  console.log(`[${f.id}]${tag}  ${f.name}`)
  console.log(`         ${f.detail}`)
}

if (worst !== 'PASS') {
  console.log('')
  console.log('ACTION')
  for (const f of findings) {
    if (!f.action) continue
    console.log('')
    console.log(`  · [${f.id}] ${f.name}`)
    for (const line of wrap(f.action, 80)) console.log(`    ${line}`)
  }
  console.log('')
  if (worst === 'STOP') {
    console.log('  STOP 的含义:不要接着修下一条 review 意见然后 push。先按上面 ACTION 处理范围与')
    console.log('  节奏问题;若结论是"必须拆"或"要改产品目标",那是产品决策 — 交给用户,别自行裁决。')
  }
}

process.exit(worst === 'STOP' ? 2 : 0)
