import { describe, expect, it } from 'vitest';

import { stripDataHeredocBodies } from '../../../../src/tools/bash-safety-scan.js';

describe('stripDataHeredocBodies', () => {
  it('drops a data heredoc body and keeps the next command on its own line', () => {
    expect(stripDataHeredocBodies("cat <<'EOF'\nsecret text\nEOF\nls -la")).toBe(
      "cat <<'EOF'\nls -la",
    );
  });

  it('drops every data heredoc body in a compound command', () => {
    expect(stripDataHeredocBodies("cat <<'A' && cat <<'B'\none\nA\ntwo\nB\necho done")).toBe(
      "cat <<'A' && cat <<'B'\n\necho done",
    );
  });

  it.each([
    "bash <<'EOF'\necho hi\nEOF",
    "cat <<'EOF' | sh\necho hi\nEOF",
    'echo "<<EOF"\necho hi\nEOF',
    'echo plain',
    'cat <<EOF\n$(date)\nEOF',
    'cat <<EOF\n`date`\nEOF',
    'cat <<EOF\n$\\\n(date)\nEOF',
    "{\ncat <<'EOF'\necho hi\nEOF\n} | sh",
    "tee >(sh) <<'EOF'\necho hi\nEOF",
    "cat > run.sh <<'EOF'\necho hi\nEOF\n./run.sh",
    "ssh host <<'EOF'\necho hi\nEOF",
    "cat <<'EOF' | xargs echo\nhi\nEOF",
    "git -c alias.run='!sh' run <<'EOF'\necho hi\nEOF",
    "git run <<'EOF'\necho hi\nEOF",
    "gh pr create --body-file - <<'EOF'\nhi\nEOF",
    "git -C \"$(pwd)\" commit -F - <<'EOF'\nhi\nEOF",
    "tee >\\\n(sh) <<'EOF'\nhi\nEOF",
    "./cat <<'EOF'\nhi\nEOF",
    "PATH=.; cat <<'EOF'\nhi\nEOF",
    "cat () { sh; }; cat <<'EOF'\nhi\nEOF",
    "( cat <<'EOF'\nhi\nEOF\n)",
    " PATH=.; cat <<'EOF'\nhi\nEOF",
    "printf -v PATH %s .; cat <<'EOF'\nhi\nEOF",
    "cat >> .git/config <<'EOF'\n[core]\nEOF\ngit commit --allow-empty",
    // Without `-F -`, or with an editor/interactive option, git hands stdin on.
    "git commit --allow-empty <<'EOF'\nhi\nEOF",
    "git commit -F - --edit <<'EOF'\nhi\nEOF",
    "git commit -eF - <<'EOF'\nhi\nEOF",
    "git tag -a v1 <<'EOF'\nhi\nEOF",
    "git notes add <<'EOF'\nhi\nEOF",
    "git add -p <<'EOF'\ny\nEOF",
  ])('returns the command unchanged when the body may run: %j', (command) => {
    expect(stripDataHeredocBodies(command)).toBe(command);
  });

  it.each([
    ["cat <<'EOF'\n`date` $(date)\nEOF\nls", "cat <<'EOF'\nls"],
    ['cat <<"EOF"\n$(date)\nEOF\nls', 'cat <<"EOF"\nls'],
    ['cat <<\\EOF\n$(date)\nEOF\nls', 'cat <<\\EOF\nls'],
    ['cat <<EOF\n$HOME only\nEOF\nls', 'cat <<EOF\nls'],
    ["git -C ../repo commit -F - <<'EOF'\nmsg\nEOF", "git -C ../repo commit -F - <<'EOF'\n"],
    ["git add -A && git commit -F - <<'EOF'\nmsg\nEOF", "git add -A && git commit -F - <<'EOF'\n"],
    ["git commit --file=- <<'EOF'\nmsg\nEOF", "git commit --file=- <<'EOF'\n"],
    ["git commit -F- <<'EOF'\nmsg\nEOF", "git commit -F- <<'EOF'\n"],
    ["git notes add -F - <<'EOF'\nmsg\nEOF", "git notes add -F - <<'EOF'\n"],
    // Option-looking text inside the body is not a git argument.
    ["git commit -F - <<'EOF'\nfix: drop --edit\nEOF", "git commit -F - <<'EOF'\n"],
  ])('treats substitution text as data when the shell does not run it: %j', (command, expected) => {
    expect(stripDataHeredocBodies(command)).toBe(expected);
  });
});
