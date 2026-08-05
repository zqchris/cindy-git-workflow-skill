#!/usr/bin/env node
// PR 总管 v4.1 预检:head 批次握手。
// exit 0=存在“新 head 且 checks + 配置声明的全部 bot 已完成”的整批事件;
// exit 2=静默等待。只侦测/落状态,不投递、不改 PR。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SWEEPS = path.join(os.homedir(), '.agents/skills/git-workflow/sweeps');
const PENDING = path.join(SWEEPS, '_pending.json');
const COORDINATOR = path.join(SWEEPS, '_coordinator-state.json');
const GATE = path.join(os.homedir(), '.agents/skills/git-workflow/scripts/check-pr-state.sh');
const CACHE_DIR = path.join(os.homedir(), '.cache/git-workflow-heartbeat');
const CHECK_AGAIN_MS = 15 * 60e3;
const BOT_WAIT_MAX_MS = 3 * 3600e3;
const MARK_TTL = {
  'gate-escalate': 24 * 3600e3,
  'stale-nudge': 24 * 3600e3,
  ttl: 6 * 3600e3,
  terminal: 6 * 3600e3,
  fail: 6 * 3600e3,
  conflict: 24 * 3600e3,
  behind: 6 * 3600e3,
};
const GATE_ESCALATE_AFTER_MS = 12 * 3600e3;
const STALE_NUDGE_AFTER_MS = 10 * 3600e3;
const now = Date.now();
const log = (message) => process.stderr.write('[detect] ' + message + '\n');
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', timeout: 45000 });
const readJson = (file, fallback) => {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
};
const markPath = (repo, pr, kind) =>
  path.join(CACHE_DIR, repo.replace('/', '_') + '_pr' + pr + '.' + kind + '-mark');
const markDue = (repo, pr, kind) => {
  const ttl = MARK_TTL[kind] ?? 6 * 3600e3;
  try {
    if (now - fs.statSync(markPath(repo, pr, kind)).mtimeMs < ttl) return false;
  } catch {}
  return true;
};
const setMark = (repo, pr, kind) => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(markPath(repo, pr, kind), String(now) + '\n');
};

const pending = readJson(PENDING, { entries: {} });
pending.entries ||= {};
const coordinator = readJson(COORDINATOR, { prs: {} });
coordinator.prs ||= {};

// ---- owner 空闲探测(2026-08-01 用户裁决:owner 工作时零打扰零排队,空闲才投递) ----
// 权威信号:Cindy 主库 sessions.active_turn_started_at > last_turn_ended_at = turn 运行中;
// agent_input_queue_snapshots.payload 非空 = 队列有积压(上一条还没消化,绝不加塞)。
// 探测失败(库不可读/schema 变了)返回 null → 放行,由总管 agent 在投递前做 MCP 侧最终核验。
const CINDY_DIR = path.join(os.homedir(), 'Library/Application Support/Cindy');
const STUCK_TURN_MS = 6 * 3600e3; // turn 超 6h 视为挂死,不再永久挡投递
let cindyDbFile = null;
try {
  cindyDbFile = fs.readdirSync(CINDY_DIR).find((f) => /^cindy-[a-z0-9]+\.db$/.test(f)) || null;
} catch {}
const busyCache = new Map();
function ownerBusy(sessionId) {
  if (!sessionId || !/^[0-9a-fA-F-]{36}$/.test(sessionId) || !cindyDbFile) return null;
  if (busyCache.has(sessionId)) return busyCache.get(sessionId);
  let result = null;
  try {
    const sql =
      "SELECT COALESCE(active_turn_started_at,0) || '|' || COALESCE(last_turn_ended_at,0) || '|' || " +
      "COALESCE((SELECT json_array_length(payload) FROM agent_input_queue_snapshots q WHERE q.session_id = s.id), 0) " +
      "FROM sessions s WHERE s.id = '" + sessionId + "'";
    const out = execFileSync('sqlite3', ['-readonly', path.join(CINDY_DIR, cindyDbFile), sql], {
      encoding: 'utf8',
      timeout: 8000,
    }).trim();
    if (out) {
      const [startedAt, endedAt, queued] = out.split('|').map(Number);
      const turnRunning = startedAt > 0 && startedAt > endedAt && now - startedAt < STUCK_TURN_MS;
      result = { turnRunning, queued: queued || 0, busy: turnRunning || (queued || 0) > 0 };
    }
  } catch (error) {
    log('busy-probe fail(' + sessionId.slice(0, 8) + '): ' + error.message);
  }
  busyCache.set(sessionId, result);
  return result;
}

function eventKey(cfg, item, kind) {
  return cfg.repo + '#' + item.number + ':' + kind;
}

const gitLocal = (repoDir, args) =>
  execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

// ---- 本机证据自动补登记(2026-08-02 用户裁决:发布会话漏登记 = 自动跟进失联,需要兜底) ----
// 只补登记「本机存在同名 head 分支」的 open PR:其它机器发布的 PR 本机无分支,天然排除,
// 不违反 2026-07-31「不接管别机 PR」的原意。owner 从 Cindy DB 的 session_pr_refs 反查
// (active session 优先);查不到 owner 只落 fail 事件交总管报告,绝不自建会话。
function autoRegister(cfg, configPath) {
  if (!cfg.author || !cfg.localRepo) return;
  try {
    if (!fs.statSync(cfg.localRepo).isDirectory()) return;
  } catch {
    return;
  }
  let open;
  try {
    open = JSON.parse(
      gh(['pr', 'list', '-R', cfg.repo, '--author', cfg.author, '--state', 'open', '--json', 'number,headRefName,title']),
    );
  } catch (error) {
    log(cfg.repo + ' autoreg: gh pr list 失败 ' + String(error.message).slice(0, 80));
    return;
  }
  cfg.tracked ||= [];
  const known = new Set(cfg.tracked.map((t) => t.number));
  const ignored = new Set(cfg.ignore || []);
  let changed = false;
  for (const pr of open) {
    if (known.has(pr.number) || ignored.has(pr.number)) continue;
    try {
      gitLocal(cfg.localRepo, ['rev-parse', '--verify', 'refs/heads/' + pr.headRefName]);
    } catch {
      log(cfg.repo + '#' + pr.number + ': 本机无分支 ' + pr.headRefName + ',跳过(可能属其它机器)');
      continue;
    }
    let worktree = '';
    try {
      for (const block of gitLocal(cfg.localRepo, ['worktree', 'list', '--porcelain']).split('\n\n')) {
        if (block.includes('branch refs/heads/' + pr.headRefName)) {
          worktree = (block.match(/^worktree (.+)$/m) || [])[1] || '';
          break;
        }
      }
    } catch {}
    let owner = '';
    if (cindyDbFile) {
      const repoName = cfg.repo.split('/')[1];
      try {
        owner = execFileSync(
          'sqlite3',
          [
            '-readonly',
            path.join(CINDY_DIR, cindyDbFile),
            "SELECT s.id FROM session_pr_refs r JOIN sessions s ON s.id = r.session_id " +
              "WHERE r.repo = '" + repoName + "' AND r.pr_number = " + Number(pr.number) +
              " AND s.status = 'active' ORDER BY r.last_seen_at DESC LIMIT 1",
          ],
          { encoding: 'utf8', timeout: 8000 },
        ).trim();
      } catch {}
    }
    const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, '+00:00');
    cfg.tracked.push({
      number: pr.number,
      owner,
      branch: pr.headRefName,
      worktree,
      addedAt: iso(now),
      deadline: iso(now + 7 * 24 * 3600e3),
      brief: String(pr.title || '').slice(0, 30) + '(自动补登记)',
    });
    changed = true;
    log(cfg.repo + '#' + pr.number + ': 自动补登记 owner=' + (owner ? owner.slice(0, 8) : '空缺') + ' branch=' + pr.headRefName);
    if (!owner && markDue(cfg.repo, pr.number, 'fail')) {
      addSimpleEvent(cfg, { number: pr.number, owner: '', worktree, brief: pr.title }, 'fail', '自动补登记成功但找不到 owner session,待人工绑定');
      setMark(cfg.repo, pr.number, 'fail');
    }
  }
  if (changed) fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

function dropEvent(cfg, item, kind, reason) {
  const key = eventKey(cfg, item, kind);
  if (pending.entries[key]) {
    delete pending.entries[key];
    log('drop ' + key + ': ' + reason);
  }
}

function addSimpleEvent(cfg, item, kind, headline) {
  const key = eventKey(cfg, item, kind);
  const prior = pending.entries[key];
  const event = prior || {
    repo: cfg.repo,
    pr: item.number,
    kind,
    firstSeen: now,
    waves: 0,
  };
  event.owner = item.owner || '';
  event.worktree = item.worktree || '';
  event.brief = item.brief || '';
  event.lastSeen = now;
  event.waves = (event.waves || 0) + 1;
  event.headline = headline;
  delete event.holdUntil;
  pending.entries[key] = event;
  log('event ' + key + ' waves=' + event.waves);
}

function readLiveBatch(cfg, item) {
  return JSON.parse(
    gh([
      'pr',
      'view',
      String(item.number),
      '--repo',
      cfg.repo,
      '--json',
      'state,isDraft,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,reviews',
    ]),
  );
}

function checkIsTerminal(check) {
  if (typeof check.status === 'string') return check.status === 'COMPLETED';
  if (typeof check.state === 'string') return !['PENDING', 'EXPECTED'].includes(check.state);
  return false;
}

function botSignals(cfg, live) {
  const expected = Array.isArray(cfg.reviewBots) ? cfg.reviewBots : [];
  return expected.map((bot) => {
    if (bot && bot.type === 'review' && typeof bot.login === 'string') {
      const done = (live.reviews || []).some(
        (review) =>
          review?.author?.login === bot.login &&
          review?.commit?.oid === live.headRefOid,
      );
      return { id: 'review:' + bot.login, done };
    }
    if (bot && bot.type === 'check' && typeof bot.name === 'string') {
      const check = (live.statusCheckRollup || []).find((entry) => entry?.name === bot.name);
      return { id: 'check:' + bot.name, done: !!check && checkIsTerminal(check) };
    }
    return { id: 'invalid-config', done: false };
  });
}

function evaluateFactsBatch(cfg, item, live, detectorHeadline) {
  const stateKey = cfg.repo + '#' + item.number;
  const prState =
    coordinator.prs[stateKey] ||
    coordinator.prs[stateKey + ':facts'] ||
    {};
  const lockedHead =
    prState.awaitingOwnerPushHead ||
    prState.lastDeliveredHead ||
    prState.lastInformedHead ||
    null;

  if (live.headRefOid && live.headRefOid === lockedHead) {
    dropEvent(cfg, item, 'facts', 'same head already delivered; awaiting owner push');
    // 已交付 head 上后来才出现的 merge 冲突(main 前移):不能被 head 锁吞掉,
    // 单独发一次性 conflict 事件提醒 rebase(24h 防重;owner 空闲门照常适用)。
    if (live.mergeable === 'CONFLICTING' && markDue(cfg.repo, item.number, 'conflict')) {
      addSimpleEvent(
        cfg,
        item,
        'conflict',
        '已交付 head ' + lockedHead.slice(0, 8) + ' 之后出现 merge 冲突,需先 rebase 再继续',
      );
      setMark(cfg.repo, item.number, 'conflict');
    }
    log(stateKey + ': locked on ' + live.headRefOid.slice(0, 8));
    return;
  }

  const key = eventKey(cfg, item, 'facts');
  const prior = pending.entries[key];
  const sameBatch = prior?.batchHead === live.headRefOid;
  const event = sameBatch
    ? prior
    : {
        repo: cfg.repo,
        pr: item.number,
        kind: 'facts',
        firstSeen: now,
        waves: 0,
        batchHead: live.headRefOid,
      };

  event.owner = item.owner || '';
  event.worktree = item.worktree || '';
  event.brief = item.brief || '';
  event.lastSeen = now;
  event.waves = (event.waves || 0) + 1;
  event.detectorHeadline = detectorHeadline;
  event.batchHead = live.headRefOid;

  const checks = live.statusCheckRollup || [];
  const checksReady = checks.every(checkIsTerminal);
  const signals = botSignals(cfg, live);
  const botsReady = signals.every((signal) => signal.done);
  const missing = signals.filter((signal) => !signal.done).map((signal) => signal.id);
  const timedOut = now - event.firstSeen >= BOT_WAIT_MAX_MS;

  // 硬阻塞直通:冲突 head / 红 CI 上 bot 波常常永远收不齐,而 owner 反正要换 head,
  // 不等 reviewBots 直接放行(仍走 owner 空闲门、仍一 head 一次)。
  const checksFailed = checks.some((check) =>
    /FAILURE|ERROR|TIMED_OUT|CANCELLED|STARTUP_FAILURE/i.test(
      String(check.conclusion ?? check.state ?? ''),
    ),
  );
  const hardBlockers = [
    ...(live.mergeable === 'CONFLICTING' ? ['conflict'] : []),
    ...(checksFailed ? ['checks-red'] : []),
  ];

  // 无可行动项的干净 head 不成批:unresolved=0 且无硬阻塞且无人类 CHANGES_REQUESTED 时,
  // 不生成/清除 facts 事件——空 handoff 违规(2026-08-02 用户反馈:owner 被零内容交接空转)。
  // bots 之后真的留下 unresolved 线程时,事件会自然重新生成。探测失败(null)按原逻辑放行。
  let unresolved = null;
  try {
    const [repoOwner, repoName] = cfg.repo.split('/');
    const threadsQuery =
      'query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{isResolved}}}}}';
    const threadsData = JSON.parse(
      gh(['api', 'graphql', '-f', 'query=' + threadsQuery, '-F', 'o=' + repoOwner, '-F', 'n=' + repoName, '-F', 'p=' + String(item.number)]),
    );
    unresolved = (threadsData.data.repository.pullRequest.reviewThreads.nodes || []).filter(
      (node) => !node.isResolved,
    ).length;
  } catch (error) {
    log(stateKey + ' unresolved-probe fail: ' + error.message);
  }
  const humanBlock = live.reviewDecision === 'CHANGES_REQUESTED';
  if (unresolved === 0 && hardBlockers.length === 0 && !humanBlock) {
    dropEvent(cfg, item, 'facts', 'clean head: unresolved=0, no blockers, nothing to hand off');
    log(stateKey + ': clean head ' + String(live.headRefOid || '').slice(0, 8) + ', no facts event');
    return;
  }

  event.unresolved = unresolved;
  event.checksReady = checksReady;
  event.botSignals = signals;
  event.missingSignals = missing;
  event.hardBlockers = hardBlockers;
  event.batchState = hardBlockers.length
    ? 'ready'
    : checksReady && botsReady
      ? 'ready'
      : timedOut
        ? 'review-timeout'
        : 'collecting';

  if (hardBlockers.length) {
    delete event.holdUntil;
    event.headline =
      '硬阻塞直通(' + hardBlockers.join('+') + '): head=' +
      String(live.headRefOid || '').slice(0, 8) +
      ' 带上当前已有 review 一次交付';
    pending.entries[key] = event;
    log(key + ': eligible; ' + event.headline);
    return;
  }

  if (event.batchState === 'collecting') {
    event.holdUntil = now + CHECK_AGAIN_MS;
    event.headline =
      '等待整批完成: head=' +
      String(live.headRefOid || '').slice(0, 8) +
      ' checks=' +
      (checksReady ? 'done' : 'running') +
      ' missing=' +
      (missing.join(',') || 'none');
    pending.entries[key] = event;
    log(key + ': collecting; ' + event.headline);
    return;
  }

  delete event.holdUntil;
  event.headline =
    event.batchState === 'ready'
      ? '整批已收齐: head=' + String(live.headRefOid || '').slice(0, 8)
      : '整批等待超时(只报一次基础设施状态): head=' +
        String(live.headRefOid || '').slice(0, 8) +
        ' checks=' +
        (checksReady ? 'done' : 'running') +
        ' missing=' +
        (missing.join(',') || 'none');
  pending.entries[key] = event;
  log(key + ': eligible; ' + event.headline);
}

for (const file of fs.readdirSync(SWEEPS)) {
  if (!file.endsWith('.json') || file.startsWith('_')) continue;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(SWEEPS, file), 'utf8'));
  } catch (error) {
    log('bad config ' + file + ': ' + error.message);
    continue;
  }
  if (!cfg || !cfg.repo) continue;

  // 先补登记再巡检:本轮新发现的 PR 立刻进入正常侦测流程。
  try {
    autoRegister(cfg, path.join(SWEEPS, file));
  } catch (error) {
    log(cfg.repo + ' autoreg ERROR ' + String(error.message).slice(0, 100));
  }

  for (const item of cfg.tracked || []) {
    try {
      if (Date.parse(item.deadline) <= now) {
        if (markDue(cfg.repo, item.number, 'ttl')) {
          addSimpleEvent(cfg, item, 'ttl', 'tracking TTL(7天)已到,PR 仍在跟踪');
          setMark(cfg.repo, item.number, 'ttl');
        }
        continue;
      }

      if (
        item.gate &&
        item.gate.at &&
        now >= Date.parse(item.gate.at) + GATE_ESCALATE_AFTER_MS &&
        markDue(cfg.repo, item.number, 'gate-escalate')
      ) {
        const issueNumber = String(item.gate.issue || '').replace('#', '');
        let issueState = 'OPEN';
        try {
          issueState = JSON.parse(
            gh(['issue', 'view', issueNumber, '--repo', cfg.repo, '--json', 'state']),
          ).state;
        } catch {}
        if (issueState === 'OPEN') {
          addSimpleEvent(
            cfg,
            item,
            'gate',
            'product-gate 卡点超 12h 未放行(issue #' +
              issueNumber +
              ', gate ' +
              item.gate.at +
              ')',
          );
          setMark(cfg.repo, item.number, 'gate-escalate');
        }
      }

      let detector = 'FAIL';
      try {
        detector =
          execFileSync('bash', [GATE, String(item.number), cfg.repo], {
            encoding: 'utf8',
            timeout: 45000,
          })
            .trim()
            .split('\n')[0] || 'FAIL';
      } catch (error) {
        detector =
          String(error?.stdout || '')
            .trim()
            .split('\n')[0] || 'FAIL';
      }
      log(cfg.repo + '#' + item.number + ': ' + detector);

      if (detector.startsWith('TERMINAL')) {
        dropEvent(cfg, item, 'facts', 'terminal');
        if (markDue(cfg.repo, item.number, 'terminal')) {
          addSimpleEvent(cfg, item, 'terminal', detector);
          setMark(cfg.repo, item.number, 'terminal');
        }
        continue;
      }
      if (detector.startsWith('FAIL')) {
        if (markDue(cfg.repo, item.number, 'fail')) {
          addSimpleEvent(cfg, item, 'fail', detector);
          setMark(cfg.repo, item.number, 'fail');
        }
        continue;
      }

      const live = readLiveBatch(cfg, item);
      if (live.state !== 'OPEN') continue;
      evaluateFactsBatch(cfg, item, live, detector);

      // 已 approve 但分支落后 base:仓库要求 up-to-date 时这就是唯一阻断,
      // 而它既不产生 unresolved 线程也不是 conflict,老口径会当"干净"漏掉
      // (2026-08-05 实踩:#1685/#1700 双双 APPROVED+全绿+BEHIND,maintainer
      // 催了 3 小时无人响应)。单独发 behind 事件提醒 owner 更新分支。
      if (
        live.reviewDecision === 'APPROVED' &&
        live.mergeStateStatus === 'BEHIND' &&
        markDue(cfg.repo, item.number, 'behind')
      ) {
        addSimpleEvent(
          cfg,
          item,
          'behind',
          '已 approve 但分支落后 base(BEHIND),无法合并;请 owner 执行 gh pr update-branch ' +
            item.number +
            ' 或在 worktree merge origin/main 后 push,checks 绿后交仓库方合并',
        );
        setMark(cfg.repo, item.number, 'behind');
      }

      const batchKey = eventKey(cfg, item, 'facts');
      const batchPending = pending.entries[batchKey];
      // 干等催人:没有待交付批次的 PR(含干净 head 不成批的情况)超龄仍无人审/无人合 → stale 事件。
      if (
        !batchPending &&
        !(item.gate && item.gate.at) &&
        markDue(cfg.repo, item.number, 'stale-nudge')
      ) {
        const created = JSON.parse(
          gh([
            'pr',
            'view',
            String(item.number),
            '--repo',
            cfg.repo,
            '--json',
            'createdAt,isDraft,reviewDecision',
          ]),
        );
        if (
          !created.isDraft &&
          now - Date.parse(created.createdAt) >= STALE_NUDGE_AFTER_MS
        ) {
          addSimpleEvent(
            cfg,
            item,
            'stale',
            '干等' +
              (created.reviewDecision === 'APPROVED' ? '合并' : ' review') +
              '超 10h(PR 干净)',
          );
          setMark(cfg.repo, item.number, 'stale-nudge');
        }
      }
    } catch (error) {
      log(cfg.repo + '#' + item.number + ' ERROR ' + error.message);
    }
  }
}

fs.mkdirSync(SWEEPS, { recursive: true });
fs.writeFileSync(PENDING, JSON.stringify(pending, null, 2));
// eligible = 事件到期 且 owner 空闲(turn 没在跑、队列无积压)。owner 忙 → 本轮连模型都不唤醒,
// 事件留在 _pending.json 继续积攒;owner 空闲后的下一个 15min tick 一次性交付整批。
const eligible = Object.values(pending.entries).filter((event) => {
  if (event.holdUntil && now < event.holdUntil) return false;
  const probe = ownerBusy(event.owner);
  if (probe && probe.busy) {
    log(
      'owner-busy hold ' + event.repo + '#' + event.pr + ':' + event.kind +
      ' (turn=' + probe.turnRunning + ' queued=' + probe.queued + ')',
    );
    return false;
  }
  return true;
});
log(
  'pending=' +
    Object.keys(pending.entries).length +
    ' eligible=' +
    eligible.length,
);
process.exit(eligible.length ? 0 : 2);
