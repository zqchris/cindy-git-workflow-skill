#!/usr/bin/env node
// pr-size-gate.mjs — 开 ready PR 前的入口规模闸门。
//
// 为什么需要它(2026-08-04 复盘):pr-drift-check 是 push 前的闸门,它要求 PR 已经存在,
// 所以只能测"进 review 后涨了多少",测不到"开局就开得太大"。而当天数据显示规模与 review
// 轮数不是线性关系,是断崖——**按非测试代码口径**统计:
//     +22 行 → 0-1 轮    +54 行 → 1 轮      +212 行 → 0 轮(刚开)
//     +292 行 → 4 轮     +453 行 → 3 轮(未完)   +450 行 → 8 轮(废弃重做)
// 几十行的 PR 根本不振荡——不是因为它更规范,而是邻域太小,bot 挖不出东西。三百行往上必进
// 循环。所以最有效的控制不是"进了循环怎么刹车",而是"别开那么大的 PR"。
//
// **必须按非测试口径统计,否则闸门失效**:#1636 总插入 1071 行,其中 779 行是测试,实现面
// 只有 292 行;#1635 总 1697 行,实现面 453 行。用总行数当判据会把"实现小、回归测试厚"的
// 健康 PR 误判成巨物,同时让真正的大实现藏在测试行的噪音里——两头都错。
//
// 用法: node pr-size-gate.mjs [--base <ref>] [--json]
//   在要开 PR 的分支/worktree 内运行,不需要 PR 号(此时 PR 还不存在)。
// 输出: 第一行 PASS / WARN: <摘要> / STOP: <摘要>,之后是明细与 ACTION。
// 退出码: 0=PASS/WARN, 2=STOP。

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const baseArg = (() => {
  const i = argv.indexOf('--base')
  return i >= 0 ? argv[i + 1] : null
})()

// 阈值。insStop=300 取自当日梯度:166 行的 PR 一轮就过,1071 行的跑了四轮。
// 测试与快照文件单独统计并从主判据里扣除——它们体量大但几乎不引发 review 循环
// (bot 极少对测试断言反复挖边界),把它们计入会把正常的"实现+回归测试"误判成巨物。
const T = {
  insWarn: 150,
  insStop: 300,
  filesWarn: 12,
  filesStop: 25,
}

const TEST_RE = /(^|\/)(__tests__|__snapshots__|test|tests|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.snap$/

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

const branch = sh('git', ['symbolic-ref', '--short', 'HEAD'])
if (!branch) {
  console.log('STOP: 不在分支上(detached HEAD 或不在 git 仓库内),无法判定规模')
  process.exit(2)
}

// 基准:优先 upstream 默认分支,其次 origin。与 preflight/git-start 的口径一致。
let base = baseArg
if (!base) {
  for (const cand of ['upstream/main', 'upstream/HEAD', 'origin/main', 'origin/HEAD', 'origin/master']) {
    if (sh('git', ['rev-parse', '--verify', '--quiet', cand])) { base = cand; break }
  }
}
if (!base) {
  console.log('STOP: 找不到 upstream/origin 默认分支引用,先 git fetch 再跑本闸门')
  process.exit(2)
}

const mb = sh('git', ['merge-base', base, 'HEAD'])
if (!mb) {
  console.log(`STOP: 无法对 ${base} 求 merge-base(基底可能太旧或未 fetch)`)
  process.exit(2)
}

const numstat = sh('git', ['diff', '--numstat', `${mb}...HEAD`])
if (numstat === null) {
  console.log('STOP: git diff 失败')
  process.exit(2)
}

// ── 意图锚点检查 ─────────────────────────────────────────────────
// 没有书面目标就没法判断 review 意见是否跑偏——每一条单看都合理,靠感觉永远刹不住。
// 契约由 git-start.sh 生成模板,放在 worktree 的 git-dir 里(不进仓库、不污染 diff)。
const gitDir = sh('git', ['rev-parse', '--absolute-git-dir'])
const intentPath = gitDir ? `${gitDir}/cindy-intent.md` : null
let intentState = 'ok'
let intentGoal = ''
let intentJustCreated = false
if (intentPath) {
  let body = null
  try { body = readFileSync(intentPath, 'utf8') } catch { body = null }
  // 不是所有 worktree 都由 git-start.sh 创建——宿主 send_to_session(use_worktree) 建的
  // .cindy-worktrees/* 就不走那条路径,契约文件不存在。这里补生成模板,让闸门不只是报错,
  // 而是把该填的东西直接摆到 agent 面前(仍然 STOP,填完才放行)。
  if (body === null) {
    try {
      const tpl = readFileSync(new URL('./intent-template.md', import.meta.url), 'utf8')
      writeFileSync(intentPath, tpl, { flag: 'wx' })
      body = tpl
      intentJustCreated = true
    } catch { /* 模板缺失或并发写入,按 missing 处理 */ }
  }
  if (body === null) intentState = 'missing'
  else if (/^\s*TODO\s*$/m.test(body)) intentState = 'unfilled'
  else {
    const m = body.match(/##\s*目标[^\n]*\n(?:<!--[\s\S]*?-->\s*\n)?\s*([^\n<][^\n]*)/)
    intentGoal = m ? m[1].trim() : ''
    if (!intentGoal) intentState = 'unfilled'
    else if (/同时|另外|顺便|以及|并且/.test(intentGoal)) intentState = 'multi-goal'
  }
}

let prodIns = 0, prodFiles = 0, testIns = 0, testFiles = 0
const top = []
for (const line of numstat.split('\n').filter(Boolean)) {
  const [a, d, file] = line.split('\t')
  if (a === '-') continue // 二进制
  const ins = Number(a) || 0
  if (TEST_RE.test(file)) { testIns += ins; testFiles += 1 }
  else { prodIns += ins; prodFiles += 1; top.push({ file, ins }) }
}
top.sort((x, y) => y.ins - x.ins)

const sizeLevel =
  prodIns >= T.insStop || prodFiles >= T.filesStop
    ? 'STOP'
    : prodIns >= T.insWarn || prodFiles >= T.filesWarn
      ? 'WARN'
      : 'PASS'
const intentLevel =
  intentState === 'missing' || intentState === 'unfilled'
    ? 'STOP'
    : intentState === 'multi-goal'
      ? 'WARN'
      : 'PASS'
const level = [sizeLevel, intentLevel].includes('STOP')
  ? 'STOP'
  : [sizeLevel, intentLevel].includes('WARN')
    ? 'WARN'
    : 'PASS'

if (asJson) {
  console.log(JSON.stringify({
    level, sizeLevel, intentLevel, intentState, intentGoal,
    base, mergeBase: mb, prodIns, prodFiles, testIns, testFiles,
  }))
  process.exit(level === 'STOP' ? 2 : 0)
}

const reasons = []
if (sizeLevel !== 'PASS') reasons.push(`非测试代码 +${prodIns} 行 / ${prodFiles} 文件`)
if (intentLevel !== 'PASS') {
  reasons.push({
    missing: '意图契约缺失且无法生成模板',
    unfilled: intentJustCreated ? '已生成意图契约模板,待填写' : '意图契约未填写(仍是 TODO)',
    'multi-goal': '目标句含「同时/另外/顺便」类连接词,疑似多目标捆绑',
  }[intentState])
}
const head = level === 'PASS' ? 'PASS' : `${level}: ${reasons.join(' · ')}`

console.log(head)
console.log('')
console.log(`分支 ${branch} · 基准 ${base} (merge-base ${mb.slice(0, 7)})`)
console.log(`  意图契约: ${
  intentState === 'ok' ? `已填写 —— 「${intentGoal}」`
  : intentState === 'multi-goal' ? `目标句可能捆了多个目标 —— 「${intentGoal}」`
  : intentState === 'unfilled' ? (intentJustCreated ? '本 worktree 原本没有,已为你生成模板 —— 填完三段再跑' : '存在但未填写(仍含 TODO)')
  : `缺失(应在 ${intentPath || '<git-dir>/cindy-intent.md'})`
}`)
console.log(`  非测试: +${prodIns} 行 / ${prodFiles} 文件   （WARN≥${T.insWarn}行或${T.filesWarn}文件 · STOP≥${T.insStop}行或${T.filesStop}文件）`)
console.log(`  测试类: +${testIns} 行 / ${testFiles} 文件   （不计入判据）`)

if (top.length) {
  console.log('')
  console.log('改动最多的非测试文件:')
  for (const t of top.slice(0, 8)) console.log(`  +${String(t.ins).padStart(5)}  ${t.file}`)
}

if (level !== 'PASS') {
  console.log('')
  console.log('ACTION')
  console.log('')
  if (intentState === 'missing' || intentState === 'unfilled') {
    console.log('  先补意图契约,再谈规模。没有书面目标,你在 review 循环里无法判断「这条意见是不是')
    console.log('  本 PR 该管的」——而每一条意见单看都合理,靠感觉永远刹不住(2026-08-04:415 行的正题')
    console.log('  被 8 轮 review 泵成 1097 行后废弃重做)。')
    console.log(`  文件位置:${intentPath || '<git-dir>/cindy-intent.md'}`)
    console.log('  三段都要填:目标(一句话,不用「同时/并/另外/顺便」连接)、非目标(容易被顺手带进来的')
    console.log('  邻域,后面 bot 提到就引用本段回复+resolve)、验收清单。')
    console.log('')
  }
  if (intentState === 'multi-goal') {
    console.log('  目标句里出现了「同时/另外/顺便/以及/并且」——那通常意味着这不是一个目标,是几个。')
    console.log('  能独立使用、独立验证、独立合并的部分拆出去另开 PR;确实拆不开就把目标改写成一句')
    console.log('  真正统一的话,不要用连接词把多件事缝起来。')
    console.log('')
  }
  if (sizeLevel === 'STOP') {
    console.log('  不要现在开 ready PR。当日数据:166 行的 PR 一轮 review 就过,1071 行的跑了四轮,')
    console.log('  1097 行的振荡 8 轮后废弃重做——规模与 review 轮数是断崖关系,不是线性。')
    console.log('')
    console.log('  先自问三条(任一答不出就是多目标捆绑):')
    console.log('    ① 目标能不能一句话说完,中间不用"同时/并/另外/顺便"连接?')
    console.log('    ② 少了其中任一部分是否就不可用?能单独用的就能单独发。')
    console.log('    ③ 描述里的"本 PR 包含"是不是一个列表?长度 > 2 基本等于目标数 > 1。')
    console.log('')
    console.log('  然后按 git-workflow「怎么问」用飞书问 Chris,三行内给出:当前行数、上面的自问结论、')
    console.log('  你建议拆成几个 PR。他说"就这么发"才继续;拆分是产品交付决定,不自行裁决。')
  } else if (sizeLevel === 'WARN') {
    console.log('  规模已进风险区。开 PR 前确认:没夹带无关重构/格式化/依赖升级,PR 描述里的目标')
    console.log('  是一句话而不是列表。确认过就继续,不需要问人。')
  }
}

process.exit(level === 'STOP' ? 2 : 0)
