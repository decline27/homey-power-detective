module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/unit/**/*.test.ts'],
  moduleNameMapper: { '^homey$': '<rootDir>/test/mocks/homey.ts' },
  modulePathIgnorePatterns: ['<rootDir>/.homeybuild/', '<rootDir>/.benchbuild/'],
  collectCoverageFrom: ['src/engine/**/*.ts', 'src/insight/**/*.ts'],
  coverageThreshold: { global: { branches: 80, functions: 90, lines: 90, statements: 90 } },
};
