import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', '**/coverage/**', '**/next-env.d.ts', 'packages/db/prisma/migrations/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['apps/api/src/modules/me/**/*.ts'],
    ignores: ['apps/api/src/modules/me/**/*.repository.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='prisma']",
          message: '/me modüllerinde veri erişimi yalnızca userId ile kapsamlanmış *.repository.ts üzerinden yapılır.',
        },
        {
          selector: "Identifier[name='PrismaService']",
          message: '/me modüllerinde PrismaService yerine *.repository.ts kullanın.',
        },
        {
          selector: "ObjectPattern > Property[key.name='prisma']",
          message: '/me modüllerinde prisma destructuring yasaktır; *.repository.ts kullanın.',
        },
        {
          selector: "Identifier[name='PrismaClient']",
          message: '/me modüllerinde PrismaClient kullanılamaz; *.repository.ts kullanın.',
        },
      ],
    },
  },
);
