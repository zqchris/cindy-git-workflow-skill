"""Exercise real Git entrypoints using disposable local remotes; no GitHub or apps."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


class WorkflowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='workflow test ')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env = os.environ.copy()
        # Do not inherit credentials, hooks, signing policy or repository overrides.
        for key in list(self.env):
            if key.startswith('GIT_'):
                del self.env[key]
        self.env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_AUTHOR_NAME='Fixture', GIT_AUTHOR_EMAIL='fixture@example.invalid',
                        GIT_COMMITTER_NAME='Fixture', GIT_COMMITTER_EMAIL='fixture@example.invalid',
                        GIT_TERMINAL_PROMPT='0')
        self.remote = self.root / 'remote.git'
        self.repo = self.root / 'project with spaces'
        self.run_at(self.root, 'git', 'init', '--bare', '--initial-branch=trunk', str(self.remote))
        self.run_at(self.root, 'git', 'clone', str(self.remote), str(self.repo))
        (self.repo / 'data.txt').write_text('original\n')
        self.git('add', 'data.txt')
        self.git('commit', '-m', 'initial')
        self.git('push', 'origin', 'trunk')
        self.git('remote', 'set-head', 'origin', '-a')

    def run_at(self, cwd, *args, expected=0):
        p = subprocess.run(args, cwd=cwd, env=self.env, text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(p.returncode, expected, p.stdout)
        return p.stdout.strip()

    def git(self, *args, cwd=None, expected=0):
        return self.run_at(cwd or self.repo, 'git', *args, expected=expected)

    def script(self, name, *args, cwd=None, expected=0):
        return self.run_at(cwd or self.repo, 'bash', str(SCRIPTS / name), *args,
                           expected=expected)

    def start(self, slug='task'):
        self.script('git-start.sh', slug, 'origin')
        return self.root / ('project with spaces-' + slug)

    def test_start_uses_live_default_preserves_dirty_primary_and_no_tracking(self):
        # Change the remote default while origin/HEAD remains stale at trunk.
        self.git('switch', '-c', 'release')
        (self.repo / 'release.txt').write_text('new default\n')
        self.git('add', 'release.txt')
        self.git('commit', '-m', 'release baseline')
        expected_head = self.git('rev-parse', 'HEAD')
        self.git('push', 'origin', 'release')
        self.run_at(self.remote, 'git', 'symbolic-ref', 'HEAD', 'refs/heads/release')
        self.git('switch', 'trunk')
        (self.repo / 'data.txt').write_text('user staged\n')
        self.git('add', 'data.txt')
        (self.repo / 'data.txt').write_text('user unstaged\n')
        (self.repo / 'notes.txt').write_text('private work\n')
        before = (self.git('status', '--porcelain'), self.git('diff'),
                  self.git('diff', '--cached'), self.git('rev-parse', 'HEAD'))
        wt = self.start()
        self.assertEqual(self.git('rev-parse', 'HEAD', cwd=wt), expected_head)
        self.assertEqual(self.git('status', '--porcelain', cwd=wt), '')
        self.assertIn('PASS:', self.script('preflight.sh', cwd=wt))
        self.git('config', '--get', 'branch.task.remote', cwd=wt, expected=1)
        self.assertEqual(before, (self.git('status', '--porcelain'), self.git('diff'),
                                 self.git('diff', '--cached'), self.git('rev-parse', 'HEAD')))
        self.assertEqual((self.repo / 'notes.txt').read_text(), 'private work\n')

    def test_primary_rejected_even_on_feature_branch(self):
        self.assertIn('FAIL:', self.script('preflight.sh', expected=2))
        self.git('switch', '-c', 'existing-work')
        self.assertIn('FAIL:', self.script('preflight.sh', expected=2))

    def test_task_warn_and_detached_rejected_without_mutation(self):
        wt = self.start()
        (wt / 'data.txt').write_text('task edit\n')
        before = self.git('diff', cwd=wt)
        self.assertIn('WARN:', self.script('preflight.sh', cwd=wt))
        self.assertEqual(before, self.git('diff', cwd=wt))
        self.git('checkout', '--detach', cwd=wt)
        self.assertIn('FAIL:', self.script('preflight.sh', cwd=wt, expected=2))

    def test_duplicate_path_and_branch_are_not_overwritten(self):
        wt = self.start()
        (wt / 'keep.txt').write_text('keep\n')
        self.assertIn('already exists', self.script('git-start.sh', 'task', expected=2))
        self.assertEqual((wt / 'keep.txt').read_text(), 'keep\n')
        self.git('branch', 'occupied')
        self.assertIn('branch already exists', self.script('git-start.sh', 'occupied', expected=2))

    def test_missing_remote_default_does_not_guess_main(self):
        self.run_at(self.remote, 'git', 'symbolic-ref', 'HEAD', 'refs/heads/missing')
        self.assertIn('not advertised', self.script('git-start.sh', 'task', expected=2))
        self.assertFalse((self.root / 'project with spaces-task').exists())
        self.git('show-ref', '--verify', '--quiet', 'refs/heads/task', expected=1)

    def test_named_upstream_and_nested_invocation(self):
        self.git('remote', 'rename', 'origin', 'canonical')
        nested = self.repo / 'nested folder'
        nested.mkdir()
        self.script('git-start.sh', 'task', 'canonical', cwd=nested)
        wt = self.root / 'project with spaces-task'
        self.assertEqual(self.git('rev-parse', 'HEAD', cwd=wt),
                         self.git('rev-parse', 'canonical/trunk'))

    def test_align_reports_ahead_behind_diverged_without_changing_head(self):
        wt = self.start()
        self.assertIn('LOCAL_ONLY:', self.script('align-branch.sh', 'task', cwd=wt))
        self.git('push', 'origin', 'task', cwd=wt)
        self.assertIn('ALIGNED:', self.script('align-branch.sh', 'task', cwd=wt))
        self.git('commit', '--allow-empty', '-m', 'local task', cwd=wt)
        local_head = self.git('rev-parse', 'HEAD', cwd=wt)
        self.assertIn('AHEAD:', self.script('align-branch.sh', 'task', cwd=wt))
        peer = self.root / 'fixture peer'
        self.run_at(self.root, 'git', 'clone', str(self.remote), str(peer))
        self.git('switch', 'task', cwd=peer)
        self.git('commit', '--allow-empty', '-m', 'remote task', cwd=peer)
        self.git('push', 'origin', 'task', cwd=peer)
        self.assertIn('DIVERGED:', self.script('align-branch.sh', 'task', cwd=wt))
        self.assertEqual(self.git('rev-parse', 'HEAD', cwd=wt), local_head)
        self.git('push', 'origin', 'HEAD:trunk', cwd=peer)
        before = self.git('rev-parse', 'trunk')
        self.assertIn('BEHIND:', self.script('align-branch.sh', 'trunk'))
        self.assertEqual(self.git('rev-parse', 'trunk'), before)

    def test_unrelated_history_is_explicit_and_unchanged(self):
        wt = self.start()
        self.git('push', 'origin', 'task', cwd=wt)
        self.git('checkout', '--orphan', 'unrelated', cwd=wt)
        self.git('commit', '-m', 'separate root', cwd=wt)
        self.git('push', 'origin', 'unrelated:task', '--force', cwd=wt)
        before = self.git('rev-parse', 'task', cwd=wt)
        self.assertIn('UNRELATED:', self.script('align-branch.sh', 'task', cwd=wt, expected=2))
        self.assertEqual(self.git('rev-parse', 'task', cwd=wt), before)


if __name__ == '__main__':
    unittest.main()
