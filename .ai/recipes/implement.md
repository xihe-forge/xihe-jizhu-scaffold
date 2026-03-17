# Implement Recipe

## When to Use

Any feature or implementation task from `dev/task.json`.

## Flow

1. **Read context**: AGENTS.md → .planning/STATE.md → relevant PRD/tech docs
2. **Analyze task**: Break into independent subtasks if possible
3. **Dispatch workers**: Launch Sonnet sub-Agents with worktree isolation
   - One Agent per subtask
   - Each gets a clear prompt with file paths, acceptance criteria, and test expectations
4. **Monitor**: Track progress via Agent dashboard
5. **Review**: Read each Agent's branch diff, check against acceptance criteria
6. **Merge**: Merge all branches, resolve any conflicts
7. **Verify**: Run build + lint + test on merged result
8. **Record**: Update task.json (done), progress.txt, STATE.md, then commit

## Prompt Template for Sub-Agent

```
You are implementing a subtask for project [PROJECT_NAME].

Task: [subtask description]
Files to create/modify: [file list]
Acceptance criteria:
- [criterion 1]
- [criterion 2]

Rules:
- Write tests first (RED), then implement (GREEN), then clean up (REFACTOR)
- Run build/lint/test before finishing
- Do NOT modify files outside your scope: [boundary list]
```

## Completion Criteria

- All acceptance criteria met
- Build passes
- Tests pass
- Progress recorded
