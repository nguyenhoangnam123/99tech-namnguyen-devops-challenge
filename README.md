# 99Tech DevOps Challenge

| Problem                           | Status                                                                                                                                               | Where                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1. Building Castle In The Cloud   | Wave 1 done: a working exchange with unit, contract, integration, e2e, chaos, abuse and load tests on a local stack. The AWS design comes in wave 2. | [src/problem1](src/problem1/README.md)   |
| 2. Diagnose Me Doctor             | Not started                                                                                                                                          | [src/problem2](src/problem2/SOLUTION.md) |
| 3. Debugging issues within system | Not started                                                                                                                                          | [src/problem3](src/problem3/README.md)   |
| 4. Ship It Twice                  | Not started                                                                                                                                          | [src/problem4](src/problem4/SOLUTION.md) |
| 5. Fortify The Castle             | Not started                                                                                                                                          | [src/problem5](src/problem5/SOLUTION.md) |

## Assumptions about the brief

- The brief mentions role-specific subsets but lists none, so all five problems are attempted.
- Problem 3 refers to "the README in Problem 4 repo". Its files are in `src/problem3`; the
  folder was renamed when the original problem 1 was removed and the README kept the old title.
- Problem 2 asks for "two production issues" but describes one scenario. It is treated as one
  scenario with several possible root causes.
- GitHub runs workflows only from the repository root, so CI lives in `.github/workflows/`
  rather than under `src/problem4/.github/`.
