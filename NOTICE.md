# NOTICE —— 第三方组件与授权

本项目自身代码以 MIT 授权发布（见 `LICENSE`）。
但它依赖一个**不是开源授权**的库，这一点必须在使用前理解清楚。

---

## 1. eltdx（必需，非商业授权）

- 项目：<https://github.com/electkismet/eltdx>（PyPI 包名 `eltdx`）
- 授权：**ELTDX Non-Commercial Learning and Data Research License**

它不是 MIT / Apache / GPL 这类开源授权。关键条款（原文摘录）：

> This project is provided only for personal learning, data-interface and format
> research, and **other non-commercial use**.
>
> You may read, use, copy, and modify the source code for **personal research purposes**.
>
> You may **not** use this project, its source code, its derived works, or data obtained
> through it for any **commercial activity, paid service, production service, resale,
> redistribution for profit, market-data vending, automated trading service** …

### 这对你意味着什么

| 场景 | 是否可以 |
|:--|:--|
| 自己部署、自己看盘（个人学习 / 研究） | ✅ 明确允许 |
| 改代码自用 | ✅ 明确允许 |
| 在公司里跑，用来辅助商业决策 | ❌ 属于 commercial use |
| 做成付费服务 / 内部生产系统 | ❌ 明确禁止 production service |
| 打包成商品出售 | ❌ 明确禁止 resale |

### 为什么「每个人自己部署」是安全的边界

本项目**不分发 eltdx 的代码**，只在 `requirements.txt` 里声明依赖，
由使用者自己 `pip install`。你拿到的是本项目自己的 MIT 代码，eltdx 由你按它自己的授权获取。

因此本项目的定位是：**一份个人自用的看盘工具源码**，不是「提供行情数据的服务」。
请勿把它部署成面向他人（尤其是面向不特定多数人）的服务。

### 数据来源

eltdx 连接的是通达信（TDX）公开行情服务器。**行情数据本身的版权归交易所及数据提供方所有**，
本项目和 eltdx 都不授予你任何行情数据的再分发权。请仅在个人研究范围内使用，
不要抓取、缓存后对外提供。

---

## 2. ECharts（已 vendor，Apache-2.0）

- 文件：`static/vendor/echarts.min.js`
- 项目：<https://echarts.apache.org/>
- 授权：Apache License 2.0

可以自由分发，保留版权声明即可。

---

## 3. IBM Plex Mono（已 vendor，OFL-1.1）

- 文件：`static/vendor/ibm-plex-mono-*.woff2`
- 项目：<https://github.com/IBM/plex>
- 授权：SIL Open Font License 1.1

可以自由分发嵌入，不得单独售卖字体本身。

---

## 4. Python 标准库

本项目后端除 eltdx 外**只用标准库**（`http.server`、`json`、`gzip`、`threading` 等），
无 Web 框架、无数据库依赖。
