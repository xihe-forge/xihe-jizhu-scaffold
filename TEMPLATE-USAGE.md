# Template Usage

## Fastest Way

Most users only need this:

```bash
pnpm install
pnpm kickoff
```

Then talk to the AI interviewer. It will:

1. ask what you want to build
2. ask a few clarification questions
3. write `.planning/*`
4. generate `dev/task.json`
5. offer to start 24/7 work

If the runtime reports a reset time after quota exhaustion, the scaffold will keep waiting and retrying automatically.
If the terminal is closed mid-interview, rerunning `pnpm kickoff` resumes from the saved kickoff state instead of restarting from zero.

If you prefer a menu instead of the direct interview, run:

```bash
pnpm start-here
```

The wizard now asks one simple runtime question:

- `Claude Code CLI`
- `Codex CLI`
- `Gemini CLI`
- `Custom command`

## 24/7 AI Mode

To let AI keep working in a dedicated terminal:

```bash
pnpm work
```

To stop it:

```bash
pnpm autopilot:stop
```

To inspect its state:

```bash
pnpm autopilot:status
```

To change the AI runtime later:

```bash
pnpm autopilot:configure
```

If you choose `Codex CLI`, the scaffold will use `codex exec` style unattended runs. If your machine only has a blocked Windows app alias, switch to a PATH-available Codex install or use `Custom command`.

If quota or rate limit is exhausted, autopilot will switch into a waiting state and retry automatically after the configured delay.

## Windows Double-Click Mode

On Windows, you can also double-click:

- `START-HERE.bat`
- `START-AUTOPILOT.bat`
- `STOP-AUTOPILOT.bat`

## Template Flow

### 1. Copy the scaffold

```powershell
Copy-Item -Recurse -Force <template-path>\robust-ai-scaffold <target-path>\my-new-project
```

### 2. Enter the copied project

```powershell
Set-Location <target-path>\my-new-project
pnpm install
pnpm kickoff
```

The intake flow will:

1. ask what product you want to build
2. ask a few AI-generated clarification questions
3. write project identity and planning files
4. save `.autopilot/config.json`
5. optionally run `health`, `autopilot:doctor`, and `build`

### 3. Customize the plan

After the wizard initializes the identity, edit:

- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `.planning/STATE.md`
- `dev/task.json`

## Explicit Commands

If you do not want the menu, you can still use:

```bash
pnpm start-here
```

If you want the direct AI interview without the menu, use:

```bash
pnpm kickoff
```

Or:

```bash
pnpm init:project --name my-new-project --scope @my-new-project --description "Your project description" --positioning "One-line product positioning"
pnpm install
pnpm health
pnpm autopilot:doctor
pnpm build
```

## Codex Skill Usage

This repository includes a Codex skill at:

- `.codex/skills/create-project-from-scaffold/SKILL.md`

If you copy that skill into your Codex skills directory, you can say:

```text
Use $create-project-from-scaffold to create a new project from <template-path>\robust-ai-scaffold into <target-path>\my-new-project. Then run the foolproof setup flow and prepare 24/7 work mode.
```

## Good Defaults

- repo name: kebab-case, e.g. `my-new-project`
- package scope: `@my-new-project`
- keep `.planning/` under version control
- keep `.autopilot/config.json` under version control
- keep `docs/intake/PROJECT-INTAKE.md` under version control
- do not commit `.intake/state.json`; it is only for interrupted kickoff recovery
- replace placeholder `apps/web` and `apps/api` bootstraps early
- use `pnpm autopilot:configure` instead of hand-editing runner fields unless you need an advanced custom command
