## Windows Shell Constraints

- Use the shell identified by the current Bash tool and follow its syntax and encoding guidance.
- The tool already launches the selected shell. Use non-interactive CLI flags and avoid redundant `powershell -Command` or `cmd /c` wrappers.
- Prefer dedicated `read`, `write`, `edit`, `grep`, and `glob` tools. For unavoidable shell file I/O, follow the selected shell's UTF-8 guidance; PowerShell 5.1 `-Encoding UTF8` writes a BOM. Avoid `Get-Content | ... | Set-Content` editing pipelines.
