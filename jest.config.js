module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/unit/**/*.test.ts', '<rootDir>/test/system/**/*.test.ts'],
  moduleNameMapper: { '^homey$': '<rootDir>/test/mocks/homey.ts' },
  modulePathIgnorePatterns: ['<rootDir>/.homeybuild/', '<rootDir>/.benchbuild/'],
  collectCoverageFrom: ['src/**/*.ts', 'app.ts'],
  coverageThreshold: { global: { branches: 80, functions: 85, lines: 90, statements: 90 } },
};
