# Adopt Existing Project Recipe

## When to Use

User has an existing project (not created by this scaffold) and wants to bring it under the scaffold's planning + autopilot framework.

## Flow

1. **Scan**: Detect existing project structure (monorepo? single app? what stack?)
2. **Interview**: Ask user about project goals, current status, what they want AI to work on
3. **Scaffold overlay**: Create missing directories and files:
   - `.planning/` (PROJECT.md, REQUIREMENTS.md, ROADMAP.md, STATE.md, config.json)
   - `dev/task.json` (initial task queue based on user goals)
   - `dev/progress.txt` (seed entry)
   - `AGENTS.md` (copy from scaffold template)
   - `.autopilot/config.json` (runtime configuration)
4. **Preserve**: Do NOT overwrite existing files. Only add what's missing.
5. **Verify**: Run health check to confirm the overlay is valid
6. **Configure runtime**: Let user pick Claude/Codex/Custom
7. **Ready**: User can now run `pnpm work` or add scripts to their package.json

## Key Principle

Adopt is additive-only. It never modifies existing source code, configs, or project structure. It only adds the planning/governance layer on top.

## Inputs

- Path to existing project (or current directory)
- User's description of what they want AI to work on
- Current project status (what's done, what's next)

## Outputs

- `.planning/` directory with populated files
- `dev/task.json` with initial tasks
- `dev/progress.txt` with seed entry
- `AGENTS.md` at project root
- `.autopilot/config.json` configured
- `docs/intake/PROJECT-INTAKE.md` with adoption context
