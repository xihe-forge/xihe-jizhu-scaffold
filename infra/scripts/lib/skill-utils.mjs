/**
 * Shared skill registry utilities used by skill-add.mjs and skill-create.mjs.
 */

/**
 * Detect circular dependencies in a skill registry by walking depends_on edges.
 *
 * @param {object} registry - Parsed skill-registry.json object
 * @returns {string[]} Array of skill IDs that participate in a cycle (empty = no cycles)
 */
export function checkCircularDependencies(registry) {
  if (!registry.skills) {
    return [];
  }

  const allSkills = {};
  for (const [moduleName, moduleData] of Object.entries(registry.skills)) {
    if (moduleData.skills) {
      for (const [skillName, skillData] of Object.entries(moduleData.skills)) {
        allSkills[`${moduleName}/${skillName}`] = skillData.depends_on || null;
      }
    }
  }

  // Warn about dangling depends_on references
  for (const [skillId, dep] of Object.entries(allSkills)) {
    if (dep && !allSkills[dep]) {
      console.warn(`Warning: Skill "${skillId}" has depends_on "${dep}" which does not exist in the registry.`);
    }
  }

  // Use WHITE/GRAY/BLACK coloring: visited = fully processed (BLACK), inStack = currently on path (GRAY)
  const visited = new Set();
  const inStack = new Set();

  function hasCycle(skillId) {
    if (inStack.has(skillId)) {
      return true; // back-edge — real cycle
    }
    if (visited.has(skillId)) {
      return false; // already fully processed — no cycle via this node
    }
    inStack.add(skillId);
    const dep = allSkills[skillId];
    if (dep && allSkills[dep]) {
      if (hasCycle(dep)) {
        inStack.delete(skillId);
        return true;
      }
    }
    inStack.delete(skillId);
    visited.add(skillId);
    return false;
  }

  const cycles = [];
  for (const skillId of Object.keys(allSkills)) {
    if (hasCycle(skillId)) {
      cycles.push(skillId);
    }
  }

  return cycles;
}
