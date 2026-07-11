import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitepress';

import { darkFirstAppearanceScript } from './theme/appearance.mjs';

const repositoryUrl = process.env.WIREROOM_REPOSITORY_URL?.replace(/\/+$/, '');

const reference = [
  { text: 'Protocol', link: '/docs/PROTOCOL' },
  { text: 'Architecture', link: '/docs/ARCHITECTURE' },
  { text: 'Privacy', link: '/docs/PRIVACY' },
  { text: 'Roadmap', link: '/docs/ROADMAP' },
];

const sidebar = [
  {
    text: 'Start here',
    items: [
      { text: 'Introduction', link: '/docs/VISION' },
      { text: 'Self-host', link: '/docs/SELF-HOST' },
      { text: 'Setup notes', link: '/docs/SETUP' },
    ],
  },
  {
    text: 'Operate',
    items: [
      { text: 'Join a live session', link: '/docs/JOIN' },
      { text: 'Adapters', link: '/docs/ADAPTERS' },
      { text: 'Roles', link: '/docs/ROLES' },
    ],
  },
  { text: 'Reference', items: reference },
  {
    text: 'Project',
    items: [
      { text: 'Business boundary', link: '/docs/BUSINESS' },
    ],
  },
];

export default defineConfig({
  title: 'Wireroom',
  description: 'A local-first room for your coding agents.',
  cleanUrls: true,
  lastUpdated: true,
  appearance: true,
  vite: {
    resolve: {
      alias: [
        {
          find: 'vue/server-renderer',
          replacement: fileURLToPath(new URL('../node_modules/vue/server-renderer/index.mjs', import.meta.url)),
        },
        {
          find: 'vue',
          replacement: fileURLToPath(new URL('../node_modules/vue/dist/vue.runtime.esm-bundler.js', import.meta.url)),
        },
      ],
    },
  },
  head: [
    ['meta', { name: 'theme-color', content: '#101114' }],
    ['meta', { name: 'color-scheme', content: 'dark light' }],
    ['script', {}, darkFirstAppearanceScript],
  ],
  themeConfig: {
    logo: false,
    siteTitle: 'Wireroom',
    nav: [
      { text: 'Docs', link: '/docs/VISION' },
      { text: 'Self-host', link: '/docs/SELF-HOST' },
      ...(repositoryUrl ? [{ text: 'Source', link: repositoryUrl }] : []),
    ],
    sidebar,
    outline: { level: [2, 3], label: 'On this page' },
    search: { provider: 'local' },
    socialLinks: repositoryUrl ? [{ icon: 'github', link: repositoryUrl }] : [],
    editLink: repositoryUrl ? {
      pattern: `${repositoryUrl}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    } : undefined,
    footer: {
      message: 'Local-first. Open protocol. MIT licensed.',
      copyright: 'Wireroom',
    },
  },
});
