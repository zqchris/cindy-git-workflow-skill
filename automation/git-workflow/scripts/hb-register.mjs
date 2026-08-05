#!/usr/bin/env node
// git-workflow 心跳登记的唯一通道(2026-07-31 起,收口清单②必须走本脚本,禁止手拼 JSON)。
// 背景:tracking 唯一入口是发布会话的显式登记,自愈扫描已废除——漏登记 = PR 彻底失联。
// #1126 实踩:发布会话手拼环节被跳过,只留一句"心跳会接管跟进",赌了不存在的兜底。
//
// 用法:
//   登记/更新: node hb-register.mjs <owner/repo> <PR号> --owner <宿主会话id> --branch <分支> \
//                [--worktree <绝对路径>] [--brief <一句话>] [--gate <issue号>,<ISO时间>,<kind>]
//   移除(终态): node hb-register.mjs <owner/repo> <PR号> --remove <原因>
//   停跟(仍OPEN): node hb-register.mjs <owner/repo> <PR号> --pause <原因>
// 行为: 在 sweeps/<owner>_<repo>.json upsert 或删除 tracked 条目(登记 deadline=+7天) → 回读验证
//       → stdout 最后一行输出汇报必须原样携带的心跳行。任何失败非零退出。
//
// --pause 与 --remove 的分工(2026-08-04 新增 --pause):
//   --remove 只服务终态 PR(MERGED/CLOSED),对 OPEN 的一律拒绝——移除即失联且无自愈兜底。
//   --pause 是**故意让一个仍 OPEN 的 PR 失联**的唯一合法出口:用于人为叫停一摊已经失控的
//   跟进(review 循环把 PR 泵成巨物、多会话交叉工作、方案要重做)。它比 --remove 多做一步:
//   把 PR 号写进 ignore[],否则预检的 autoRegister 会扫作者全量 open PR 把它自动补登记回来
//   (还会按 session_pr_refs 的 last_seen_at 重选 owner,把路过的会话选成 owner)。
//   恢复跟进 = 照常 register(会自动移出 ignore);因 draft 不建心跳,需先 gh pr ready。
//   2026-08-04 实踩:#1581/#1590/#1612 三个 draft 互相纠缠,owner 交叉 push 出方向相反的
//   commit,当时脚本没有停跟出口,只能手改 JSON——那正是本脚本存在的意义所要禁止的事。
// owner 必须是宿主会话 id(get_current_session_id 所得),不是 agent 内部 UUID——本脚本会查
// Cindy sessions 表核实它真实存在,不再只看 UUID 形状(见 assertOwnerExists 的实踩记录)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SWEEPS = process.env.GIT_WORKFLOW_SWEEPS_DIR
  ? path.resolve(process.env.GIT_WORKFLOW_SWEEPS_DIR)
  : path.join(os.homedir(), '.agents/skills/git-workflow/sweeps');
const SCHEDULE_NAME = 'PR 总管 · gw-hb/v4 (luna)';

const [repo, prRaw, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!rest[i]?.startsWith('--') || rest[i + 1] === undefined) fail(`参数不成对: ${rest[i]}`);
  opts[rest[i].slice(2)] = rest[i + 1];
}
function fail(msg) { console.error(`hb-register FAIL: ${msg}`); process.exit(1); }

if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) fail('第 1 参数须为 owner/repo');
const pr = Number(prRaw);
if (!Number.isInteger(pr) || pr <= 0) fail('第 2 参数须为 PR 号');

const isRemove = opts.remove !== undefined;
const isPause = opts.pause !== undefined;
// 两者都从 tracked[] 摘条目,差别只在允许的 live state 与是否写 ignore[]
const isDrop = isRemove || isPause;
if (isRemove && isPause) fail('--remove 与 --pause 不能同时给(终态用 --remove,仍 OPEN 的人为叫停用 --pause)');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// owner 必须是**真实存在**的 Cindy 宿主会话 id。格式合法但不存在的 id(典型:误传 agent 内部
// sdkSessionId)会让总管投递时 NOT_FOUND;而按协议「找不到 owner 时只报告、禁止接管」,那批
// review 意见就永久悬空,且要等下一轮 sweep 才暴露。
// 2026-08-03 实踩:#1421 的 owner 被登记成 claude-code 的 sdkSessionId(9f16b048…),UUID 形状
// 完全合法、旧版脚本放行,真实 owner(89d992b2…)因此收不到任何转交。
function assertOwnerExists(id) {
  let db = null;
  try {
    const dir = path.join(os.homedir(), 'Library/Application Support/Cindy');
    db = fs.readdirSync(dir)
      .filter((f) => /^cindy-.*\.db$/.test(f))
      .map((f) => path.join(dir, f))[0] || null;
  } catch { db = null; }
  if (!db) {
    console.error('hb-register WARN: 未找到 Cindy 数据库,跳过 owner 存在性校验(仅校验了 UUID 形状)');
    return;
  }
  let status;
  try {
    // id 已过 UUID 正则,不存在注入面
    status = execFileSync('sqlite3', ['-readonly', db, `SELECT status FROM sessions WHERE id='${id}'`],
      { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch (error) {
    console.error(`hb-register WARN: sqlite3 查询失败,跳过 owner 存在性校验(${String(error?.message || error).split('\n')[0]})`);
    return;
  }
  if (!status) {
    fail(`--owner ${id} 不存在于 Cindy sessions 表——极可能误传了 agent 内部 sdkSessionId。` +
      '用宿主的 get_current_session_id 取真实会话 id 后重新登记。');
  }
  if (status === 'deleted') fail(`--owner ${id} 对应的会话已删除,总管无法向它投递`);
  if (status === 'archived') {
    console.error('hb-register WARN: owner 会话当前是 archived(总管投递时会自动 resume,但请确认这确实是要跟进的会话)');
  }
}

if (isRemove) {
  if (!String(opts.remove).trim()) fail('--remove 需要给出原因(留痕用)');
} else if (isPause) {
  if (!String(opts.pause).trim()) fail('--pause 需要给出原因(留痕用)');
} else {
  if (!UUID_RE.test(opts.owner || '')) {
    fail('--owner 须为宿主会话 UUID(用 cindy helper get_current_session_id 获取;不是 agent 内部 sdkSessionId)');
  }
  if (!opts.branch) fail('--branch 必填');
  if (opts.worktree && !path.isAbsolute(opts.worktree)) fail('--worktree 须为绝对路径');
}

let live;
try {
  live = JSON.parse(execFileSync('gh', [
    'pr', 'view', String(pr), '--repo', repo,
    '--json', 'state,isDraft,headRefName',
  ], { encoding: 'utf8', timeout: 30_000 }));
} catch (error) {
  fail(`无法读取 live PR: ${String(error?.stderr || error?.message || error).trim()}`);
}

if (isRemove) {
  // 移除 = 停止跟进。对仍 OPEN 的 PR 移除会让它彻底失联(没有自愈扫描兜底),所以只允许对终态
  // PR 执行;换 owner / 换分支请直接重新登记覆盖,不要先移除。
  // 人为叫停一个仍 OPEN 的 PR 请用 --pause(它会同时写 ignore[] 防自动重纳)。
  if (live.state === 'OPEN') {
    fail(`PR #${pr} 仍是 OPEN,不允许移除 tracking——移除即失联,且无自愈兜底。` +
      '换 owner 或换分支请直接重新登记覆盖同一 PR 号;要人为叫停跟进请用 --pause <原因>。');
  }
} else if (isPause) {
  // 叫停只对 OPEN 有意义:已终态的用 --remove(不需要 ignore,autoRegister 只扫 open)。
  if (live.state !== 'OPEN') {
    fail(`PR #${pr} 已是 ${live.state},不需要 --pause——终态请用 --remove <原因>。`);
  }
} else {
  if (live.state !== 'OPEN') fail(`PR #${pr} 当前不是 OPEN(${live.state})`);
  if (live.isDraft) fail(`PR #${pr} 仍是 draft，转 ready 后再登记`);
  if (live.headRefName !== opts.branch) {
    fail(`--branch=${opts.branch} 与 live headRefName=${live.headRefName} 不一致`);
  }
  assertOwnerExists(opts.owner);
}

fs.mkdirSync(SWEEPS, { recursive: true });
const cfgPath = path.join(SWEEPS, `${repo.replace('/', '_')}.json`);
const lockPath = `${cfgPath}.lock`;
try {
  fs.mkdirSync(lockPath);
} catch {
  fail(`登记文件正被其它进程更新: ${lockPath}（稍后重试；若进程已崩溃，人工确认后清理锁目录）`);
}

let got;
let existedBefore = false;
let registrationError;
try {
  let cfg;
  if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  else cfg = { repo, author: '', notes: [], tracked: [], ignore: [] };
  if (cfg.repo !== repo) throw new Error(`${cfgPath} 的 repo 字段(${cfg.repo})与参数不符`);

  existedBefore = (cfg.tracked || []).some((t) => t.number === pr);
  if (isRemove && !existedBefore) throw new Error(`#${pr} 本来就不在 tracked 中,无需移除`);
  if (isPause && !existedBefore && (cfg.ignore || []).includes(pr)) {
    throw new Error(`#${pr} 已处于停跟状态(不在 tracked[]、已在 ignore[]),无需重复 --pause`);
  }

  const now = new Date();
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
  cfg.tracked = (cfg.tracked || []).filter((t) => t.number !== pr);
  cfg.ignore = cfg.ignore || [];

  if (isPause) {
    // 只摘 tracked 不写 ignore 是无效叫停:autoRegister 每轮扫作者全量 open PR,下一轮就把它
    // 补登记回来,还会按 session_pr_refs 的 last_seen_at 重选 owner(可能选中路过的会话)。
    if (!cfg.ignore.includes(pr)) cfg.ignore.push(pr);
    cfg.ignore.sort((a, b) => a - b);
  } else if (!isRemove) {
    // 恢复跟进:重新登记必须把它从 ignore[] 放出来,否则预检永远跳过它。
    cfg.ignore = cfg.ignore.filter((n) => n !== pr);
    const entry = {
      number: pr,
      owner: opts.owner,
      branch: opts.branch,
      worktree: opts.worktree || null,
      addedAt: iso(now),
      deadline: iso(new Date(now.getTime() + 7 * 24 * 3600e3)),
      brief: opts.brief || opts.branch,
    };
    if (opts.gate) {
      const [issue, at, kind] = opts.gate.split(',');
      if (!issue || !at) throw new Error('--gate 格式: <issue号>,<ISO时间>[,<kind>]');
      entry.gate = { issue, at, kind: kind || 'product-gate' };
    }
    cfg.tracked.push(entry);
  }

  const tmpPath = `${cfgPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(cfg, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(tmpPath, cfgPath);
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }

  // 回读验证
  const back = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  got = (back.tracked || []).find((t) => t.number === pr);
  const ignoredAfter = (back.ignore || []).includes(pr);
  if (isDrop) {
    if (got) throw new Error('回读验证失败,移除未生效');
    if (isPause && !ignoredAfter) {
      throw new Error('回读验证失败,ignore[] 未写入——autoRegister 下一轮会把它补登记回来');
    }
  } else if (!got || got.owner !== opts.owner || got.branch !== opts.branch) {
    throw new Error('回读验证失败,登记未生效');
  } else if (ignoredAfter) {
    throw new Error('回读验证失败,已进 tracked[] 但 PR 号仍在 ignore[] 中,预检会跳过它');
  }
} catch (error) {
  registrationError = error;
} finally {
  fs.rmdirSync(lockPath);
}
if (registrationError) fail(String(registrationError?.message || registrationError));

if (isPause) {
  console.error(`paused #${pr} ← ${cfgPath} (${live.state}; 原因: ${opts.pause})`);
  console.error(`  已写 ignore[] 防 autoRegister 重纳。恢复跟进: gh pr ready ${pr} 后照常 register(会自动移出 ignore)`);
  console.log(`心跳: ${SCHEDULE_NAME} 已停跟 #${pr}(仍 OPEN,已入 ignore,回读√)`);
} else if (isRemove) {
  console.error(`removed #${pr} ← ${cfgPath} (${live.state}; 原因: ${opts.remove})`);
  console.log(`心跳: ${SCHEDULE_NAME} 已移除 #${pr}(${live.state},回读√)`);
} else {
  console.error(`registered #${pr} → ${cfgPath} (owner ${opts.owner.slice(0, 8)}…, deadline ${got.deadline}${existedBefore ? '; 覆盖原有条目' : ''})`);
  console.log(`心跳: ${SCHEDULE_NAME} 已含 #${pr}(回读√)`);
}
