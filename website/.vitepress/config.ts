import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitepress';

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
    ['script', {}, `try{if(!localStorage.getItem('vitepress-theme-appearance'))document.documentElement.classList.add('dark')}catch{}`],
  ],
  themeConfig: {
    logo: false,
    siteTitle: 'Wireroom',
    nav: [
      { text: 'Docs', link: '/docs/VISION' },
      { text: 'Self-host', link: '/docs/SELF-HOST' },
      { text: 'Source', link: 'https://github.com/wireroom/wireroom' },
    ],
    sidebar,
    outline: { level: [2, 3], label: 'On this page' },
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/wireroom/wireroom' },
    ],
    editLink: {
      pattern: 'https://github.com/wireroom/wireroom/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Local-first. Open protocol. MIT licensed.',
      copyright: 'Wireroom',
    },
  },
});
