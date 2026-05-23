# tsfix demo — the vite-plugin-svgr ?react case
#
# Renders to demo.gif. Run from this directory:
#   vhs demo.tape
#
# Prereqs (see README.md):
#   - Charm vhs installed (https://github.com/charmbracelet/vhs)
#   - ANTHROPIC_API_KEY exported in the shell that runs vhs
#   - cd fixture && npm install   (one-time, before recording)

Output demo.gif

Set FontSize 14
Set Width 1200
Set Height 720
Set Theme "Dracula"
Set TypingSpeed 50ms
Set PlaybackSpeed 1.0

# --- silent setup: cd into the fixture and restore the broken file in case
#     a previous run mutated it. None of this appears in the GIF.
Hide
Type "cd fixture"
Enter
Type "git checkout -- src/Header.ts 2>/dev/null || true"
Enter
Type "clear"
Enter
Show

# --- recording begins ---

# Show the broken file (TS2614 setup).
Type "cat src/Header.ts"
Enter
Sleep 2s

# tsc fails — and note the message itself contains the WRONG quick-fix suggestion.
Type "npx tsc --noEmit"
Enter
Sleep 3s

# Run tsfix. Library-migrations registry catches vite-plugin-svgr@^4.
Type "npx @shipispec/tsfix --workspace . --llm"
Enter
Sleep 4s

# Show the fixed file — note the `?react` suffix the LLM added, NOT tsc's wrong default-import suggestion.
Type "cat src/Header.ts"
Enter
Sleep 3s

# tsc exits clean.
Type "npx tsc --noEmit && echo '✓ tsc green AND dev server works'"
Enter
Sleep 3s
