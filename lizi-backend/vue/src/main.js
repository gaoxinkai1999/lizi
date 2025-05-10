// 动态加载 public/config.json
fetch('/config.json')
  .then(res => res.json())
  .then(config => {
    const apiUrl = config.API_URL || 'http://localhost:9000';
    // 配置 axios baseURL
    import('axios').then(({ default: axios }) => {
      axios.defaults.baseURL = apiUrl;
      // 其余 Vue 初始化逻辑
      import('vue').then(({ default: Vue }) => {
        import('element-ui').then(ElementUI => {
          import('element-ui/lib/theme-chalk/index.css');
          Vue.use(ElementUI.default);
          import('vant').then(Vant => {
            import('vant/lib/index.css');
            Vue.use(Vant.default);
            Vue.config.productionTip = false;
            Vue.prototype.$http = axios;
            import('qs').then(qs => {
              Vue.prototype.$qs = qs.default;
              import('./App.vue').then(({ default: App }) => {
                new Vue({
                  render: h => h(App),
                }).$mount('#app');
              });
            });
          });
        });
      });
    });
  });
