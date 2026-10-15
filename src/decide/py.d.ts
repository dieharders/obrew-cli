/** `import src from './x.py' with { type: 'text' }` — Bun inlines the file as a string, compiled builds included. */
declare module '*.py' {
  const source: string
  export default source
}
