import { describe, expect, test } from 'bun:test'
import { pythonCandidates, pythonVersionOk } from './sidecar'

describe('pythonVersionOk', () => {
  test('3.12 and later pass; von-era 3.11 and junk fail', () => {
    expect(pythonVersionOk('3.12.0')).toBe(true)
    expect(pythonVersionOk('3.13.1\n')).toBe(true)
    expect(pythonVersionOk('4.0.0')).toBe(true)
    expect(pythonVersionOk('3.11.9')).toBe(false)
    expect(pythonVersionOk('2.7.18')).toBe(false)
    expect(pythonVersionOk('')).toBe(false)
    expect(pythonVersionOk('Python 3.12')).toBe(false)
  })
})

describe('pythonCandidates', () => {
  test('OBREW_PYTHON wins outright', () => {
    expect(pythonCandidates('win32', { OBREW_PYTHON: 'C:/py/python.exe' })).toEqual([['C:/py/python.exe']])
  })
  test('Windows goes through the py launcher, newest first', () => {
    expect(pythonCandidates('win32', {})).toEqual([['py', '-3.13'], ['py', '-3.12'], ['python']])
  })
  test('POSIX tries versioned binaries before python3', () => {
    expect(pythonCandidates('darwin', {})[0]).toEqual(['python3.13'])
    expect(pythonCandidates('linux', {}).at(-2)).toEqual(['python3'])
  })
})
