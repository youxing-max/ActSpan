import DefaultTheme from 'vitepress/theme'
import './custom.css'
import ReleaseInfo from './ReleaseInfo.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('ReleaseInfo', ReleaseInfo)
  },
}
