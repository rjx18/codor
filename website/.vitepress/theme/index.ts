import { onMounted } from 'vue';
import { useData } from 'vitepress';
import DefaultTheme from 'vitepress/theme';

import './custom.css';

export default {
  extends: DefaultTheme,
  setup() {
    const { isDark } = useData();
    onMounted(() => {
      const appearance = localStorage.getItem('vitepress-theme-appearance');
      if (appearance === null || appearance === 'auto') {
        localStorage.setItem('vitepress-theme-appearance', 'dark');
        isDark.value = true;
      }
    });
  },
};
