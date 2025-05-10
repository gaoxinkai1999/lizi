<template>
  <div id="app">
    <component :is="currentView" />
  </div>
</template>

<script>
import HelloWorld from './components/HelloWorld.vue'
import MobileView from './components/MobileView.vue' // 导入移动视图

export default {
  name: 'App',
  components: {
    HelloWorld,
    MobileView // 注册移动视图组件
  },
  data() {
    return {
      isMobile: false
    };
  },
  computed: {
    currentView() {
      return this.isMobile ? 'MobileView' : 'HelloWorld';
    }
  },
  created() {
    this.checkDeviceType();
    window.addEventListener('resize', this.checkDeviceType);
  },
  beforeDestroy() {
    window.removeEventListener('resize', this.checkDeviceType);
  },
  methods: {
    checkDeviceType() {
      // 一个简单的设备检测逻辑，可以根据需要改进
      // 例如使用 navigator.userAgent 或更复杂的库
      const userAgent = navigator.userAgent || navigator.vendor || window.opera;
      if (/android/i.test(userAgent) || /iPad|iPhone|iPod/.test(userAgent) && !window.MSStream) {
        this.isMobile = true;
      } else if (window.innerWidth <= 768) { // 也可以基于屏幕宽度
         this.isMobile = true;
      }
      else {
        this.isMobile = false;
      }
    }
  }
}
</script>

<style>
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-align: center;
  color: #2c3e50;
  /* margin-top: 60px; */ /* 移动端可能不需要顶部边距，或由NavBar处理 */
}
/* 确保 #app 元素充满视口，以便移动视图正确布局 */
html, body, #app {
  height: 100%;
  margin: 0;
  padding: 0;
}
body {
  background-color: #f7f8fa; /* Vant 默认背景色，可选 */
}
</style>
