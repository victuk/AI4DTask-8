const flags = new Map();
export async function getFlagDefinition(key) {
  if (key === 'nope') return null;
  return flags.get(key) ?? { key, enabled: false };
}
