"""Shell-prompt environment for desk tabs (final:fix).

bash readline (seen on 5.3) erases one line too many when a window resize lands on a prompt that is
exactly the terminal width and holds a multi-byte character, e.g. the ' \u00b7 ' in
'Research lab \u00b7 Codex desk'. Walking from the 80-column desk monitor to the full-screen grid
then wiped the last output line. The prompt keeps its words but uses an ASCII separator, and long
paths are trimmed (PROMPT_DIRTRIM) so prompts rarely reach the monitor width at all. Only the shell
prompt variable changes; Omo labels and titles keep the real name.
"""


def prompt_safe(env):
    out = list(env)
    for i in range(1, len(out), 2):
        if out[i - 1] == "-e" and out[i].startswith("OMO_WORKSPACE_NAME="):
            out[i] = out[i].replace("\u00b7", "-")
    return out + ["-e", "PROMPT_DIRTRIM=3"]
