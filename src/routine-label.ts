export function routineLabel(name: string, args: string): string {
  return `${name}(${args.trim()})`;
}

export function routineNameFromLabel(label: string): string {
  let depth = 0;
  for (let i = label.length - 1; i >= 0; i--) {
    const ch = label[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      depth--;
      if (depth === 0) return label.slice(0, i);
      if (depth < 0) break;
    }
  }
  return label;
}
