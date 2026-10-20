/// <reference types="vite/client" />

// vite.config.*.ts 用 define 把 process.env.APP_VERSION 替换成 package.json 的版本字面量；
// 浏览器里没有 process 运行时全局，@types/node 又已从 app 侧移除，所以在这里声明构建期契约。
declare const process: { env: { APP_VERSION: string } };
