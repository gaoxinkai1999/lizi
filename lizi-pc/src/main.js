import { createApp } from 'vue'
import ElementPlus from 'element-plus' // 导入 Element Plus
import 'element-plus/dist/index.css' // 导入 Element Plus 样式
import './style.css'
import App from './App.vue'

const app = createApp(App)

app.use(ElementPlus) // 全局注册 Element Plus
app.mount('#app')
