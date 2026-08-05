#!/usr/bin/env node
// refresh-base-refs.mjs — 本地基底保活(cindy-script/1,零 token)。
// 背景(2026-08-02):Cindy 自动 worktree 从本地 ref 切分支且不 fetch,本地 main 停在 7-25
// 时切出的工作区落后上游 1000+ commit。本脚本定时对本机主要仓库:
//   1. fetch 基准 remote(upstream 优先,否则 origin)与 origin;
//   2. 对未检出的本地默认分支做 fast-forward(git fetch <remote> <db>:<db>,只允许 ff);
// 让一切「从本地 main/HEAD 切分支」的路径天然拿到新鲜基底。
// 只动 ref,不 checkout、不 merge、不 rebase、不 push;非 ff 一律跳过并记录。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCAN_DIRS = ['~/Code/Github'];
const EXTRA_REPOS = [path.join(os.homedir(), '.agents/skills')];
const log = (m) => process.stderr.write(`[refresh] ${m}\n`);

function git(repo, args, timeout = 120000) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// 只处理主 checkout:worktree 的 .git 是文件,主仓的 .git 是目录。
function isMainCheckout(dir) {
  try {
    return fs.statSync(path.join(dir, '.git')).isDirectory();
  } catch {
    return false;
  }
}

const repos = [];
for (const scanDir of SCAN_DIRS) {
  let entries = [];
  try {
    entries = fs.readdirSync(scanDir);
  } catch {
    continue;
  }
  for (const entry of entries) {
    const dir = path.join(scanDir, entry);
    if (isMainCheckout(dir)) repos.push(dir);
  }
}
for (const extra of EXTRA_REPOS) {
  if (isMainCheckout(extra) && !repos.includes(extra)) repos.push(extra);
}

const results = [];
let failures = 0;

for (const repo of repos) {
  const name = path.basename(repo);
  try {
    let baseRemote = 'origin';
    try {
      git(repo, ['remote', 'get-url', 'upstream']);
      baseRemote = 'upstream';
    } catch {}
    try {
      git(repo, ['remote', 'get-url', baseRemote]);
    } catch {
      log(`${name}: 无可用 remote,跳过`);
      continue;
    }

    let db = 'main';
    try {
      db = git(repo, ['symbolic-ref', '--short', `refs/remotes/${baseRemote}/HEAD`]).replace(`${baseRemote}/`, '');
    } catch {
      try {
        git(repo, ['rev-parse', '--verify', `refs/remotes/${baseRemote}/main`]);
      } catch {
        db = 'master';
      }
    }

    git(repo, ['fetch', '--prune', baseRemote]);
    if (baseRemote !== 'origin') {
      try {
        git(repo, ['fetch', '--prune', 'origin']);
      } catch (error) {
        log(`${name}: fetch origin 失败(忽略): ${String(error.message).slice(0, 80)}`);
      }
    }

    let ff = 'n/a';
    let hasLocal = true;
    try {
      git(repo, ['rev-parse', '--verify', `refs/heads/${db}`]);
    } catch {
      hasLocal = false;
    }
    const checkedOut = git(repo, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .includes(`branch refs/heads/${db}`);
    if (!hasLocal) {
      ff = '无本地分支';
    } else if (checkedOut) {
      // 默认分支正被检出:仅当就是主 checkout 且工作区完全干净时做 ff-only 更新,
      // 否则跳过(绝不打扰在途工作、绝不产生 merge commit)。
      const headBranch = git(repo, ['symbolic-ref', '--short', 'HEAD']).trim();
      const clean = git(repo, ['status', '--porcelain']) === '';
      if (headBranch === db && clean) {
        const behind = git(repo, ['rev-list', '--count', `HEAD..${baseRemote}/${db}`]);
        if (behind === '0') {
          ff = '已最新';
        } else {
          try {
            git(repo, ['merge', '--ff-only', `${baseRemote}/${db}`]);
            ff = `检出分支快进+${behind}`;
          } catch (error) {
            ff = '非ff跳过';
            log(`${name}: 检出的 ${db} 非快进,未动: ${String(error.message).slice(0, 100)}`);
          }
        }
      } else {
        ff = clean ? '他处检出跳过' : '有未提交改动跳过';
      }
    } else {
      const behind = git(repo, ['rev-list', '--count', `${db}..${baseRemote}/${db}`]);
      if (behind === '0') {
        ff = '已最新';
      } else {
        try {
          git(repo, ['fetch', baseRemote, `${db}:${db}`]);
          ff = `快进+${behind}`;
        } catch (error) {
          ff = '非ff跳过';
          log(`${name}: ${db} 非快进,未动: ${String(error.message).slice(0, 100)}`);
        }
      }
    }
    results.push(`${name}→${baseRemote}/${db} ${ff}`);
    log(`${name}: ${baseRemote}/${db} ${ff}`);
  } catch (error) {
    failures += 1;
    results.push(`${name}:ERROR ${String(error.message).slice(0, 80)}`);
    log(`${name}: ${String(error.stack || error).slice(0, 300)}`);
  }
}

process.stdout.write(
  JSON.stringify({
    protocol: 'cindy-script/1',
    type: 'complete',
    resultText: (results.join(' | ') || '未发现仓库').slice(0, 1900),
  }) + '\n',
);
process.exit(failures > 0 && failures >= results.length ? 1 : 0);
