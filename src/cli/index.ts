import webpack from 'webpack';
import * as path from 'path';
import * as fs from 'fs-extra';
import platforms from './consts/platforms';
import { build as buildLog, Log, warning, error } from './packages/utils/logger/queue';
import { errorLog, warningLog } from './packages/utils/logger/index';
import chalk from 'chalk';
import getWebPackConfig from './config/webpackConfig';
import * as babel from '@babel/core';
import { spawnSync as spawn } from 'child_process';
import utils from './packages/utils/index';
import globalConfig from './config/config';
import runBeforeParseTasks from './tasks/runBeforeParseTasks';
import createH5Server from './tasks/createH5Server';
import { validatePlatforms } from './config/config';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import { intermediateDirectoryName } from './config/h5/configurations';
import * as OS from 'os';
import * as rd from 'rd';


export interface NanachiOptions {
    watch?: boolean;
    platform?: validatePlatforms;
    beta?: boolean;
    betaUi?: boolean;
    compress?: boolean;
    compressOption?: any;
    typescript?: boolean;
    huawei?: boolean;
    rules?: Array<webpack.Rule>;
    prevLoaders?: Array<string>;
    prevJsLoaders?: Array<string>;
    postJsLoaders?: Array<string>;
    prevCssLoaders?: Array<string>;
    postCssLoaders?: Array<string>;
    postLoaders?: Array<string>;
    plugins?: Array<webpack.Plugin>;
    analysis?: boolean;
    silent?: boolean;
    complete?: Function;
}

async function nanachi(options: NanachiOptions = {}) {
    const {
        // entry = './source/app', // TODO: 入口文件配置暂时不支持
        watch = false,
        platform = 'wx',
        beta = false,
        betaUi = false,
        compress = false,
        compressOption = {},
        huawei = false,
        typescript = false,
        rules = [],
        prevLoaders = [], // 自定义预处理loaders
        postLoaders = [], // 自定义后处理loaders
        prevJsLoaders = [],
        postJsLoaders = [],
        prevCssLoaders = [],
        postCssLoaders = [],
        plugins = [],
        analysis = false,
        silent = false, // 是否显示warning
        // maxAssetSize = 20480, // 最大资源限制，超出报warning
        complete = () => { }
    } = options;
    function callback(err: Error, stats?: webpack.Stats) {
        if (err) {
            // eslint-disable-next-line
            console.log(chalk.red(err.toString()));
            return;
        }
       
        showLog();
        const info = stats.toJson();
        if (stats.hasWarnings() && !silent) {
            info.warnings.forEach(warning => {
                // webpack require语句中包含变量会报warning: Critical dependency，此处过滤掉这个warning
                if (!/Critical dependency: the request of a dependency is an expression/.test(warning)) {
                    // eslint-disable-next-line
                    console.log(chalk.yellow('Warning:\n'), utils.cleanLog(warning));
                }
            });
        }
        if (stats.hasErrors()) {
            info.errors.forEach(e => {
                // eslint-disable-next-line
                console.error(chalk.red('Error:\n'), utils.cleanLog(e));
                if (utils.isMportalEnv()) {
                    process.exit();
                }
            });
        }

        if (platform === 'h5') {
            const configPath = watch ? './config/h5/webpack.config.js' : './config/h5/webpack.config.prod.js';
            const webpackH5Config = require(configPath);
            if (typescript) webpackH5Config.entry += '.tsx';

            if (globalConfig['360mode']) {
                // webpackH5Config.plugins.unshift(new CopyWebpackPlugin([{
                //     from: '**',
                //     to: path.resolve(process.cwd(), 'src'),
                //     context: path.resolve(__dirname, './packages/360helpers/template')
                // }]));
                const cwd = process.cwd();
                if (!fs.existsSync(path.join(cwd, 'src'))) {
                    fs.copySync(
                        path.resolve(__dirname, './packages/360helpers/template'),
                        path.resolve(cwd, 'src')
                    )
                }
            }
            const compilerH5 = webpack(webpackH5Config);
            if (watch) {
                createH5Server(compilerH5);
            } else {
                compilerH5.run(function(err, stats) {
                    if (globalConfig['360mode']) {
                        const appPath = path.resolve(process.cwd(), 'src/app.js');
                        let script = fs.readFileSync(appPath).toString();
                        // 动态给app.js添加import语句，将h5的jsbundle打包进来
                        script = `import './dist/web/bundle.${stats.hash.slice(0, 10)}.js';\n${script}`;
                        fs.writeFileSync(appPath, script, 'utf-8');
                        // copy h5打包产物
                        const files = fs.readdirSync(webpackH5Config.output.path);
                        fs.ensureDirSync(path.resolve(process.cwd(), './src/dist/web'));
                        files.forEach(filename => {
                            if (filename !== intermediateDirectoryName) {
                                fs.copySync(
                                    path.resolve(webpackH5Config.output.path, filename),
                                    path.resolve(process.cwd(), './src/dist/web', filename)
                                )
                            }
                        });
                    }
                    if (err) {
                        console.log(err);
                        return;
                    }
                    const info = stats.toJson();
                    if (stats.hasWarnings() && !silent) {
                        info.warnings.forEach(warning => {
                            // webpack require语句中包含变量会报warning: Critical dependency，此处过滤掉这个warning
                            if (!/Critical dependency: the request of a dependency is an expression/.test(warning)) {
                                // eslint-disable-next-line
                                console.log(chalk.yellow('Warning:\n'), utils.cleanLog(warning));
                            }
                        });
                    }
                    if (stats.hasErrors()) {
                        info.errors.forEach(e => {
                            // eslint-disable-next-line
                            console.error(chalk.red('Error:\n'), utils.cleanLog(e));
                            if (utils.isMportalEnv()) {
                                process.exit();
                            }
                        });
                    }
                });
            }
        }
        complete(err, stats);
    }
    try {
        // 360不支持watch模式
        if (watch && globalConfig['360mode']) {
            throw new Error('360编译不支持watch模式');
        }
        if (!utils.validatePlatform(platform, platforms)) {
            throw new Error(`不支持的platform：${platform}`);
        }
        // 是否使用typescript编译
        const useTs = fs.existsSync(path.resolve(process.cwd(), './source/app.tsx'));
        if (useTs && !typescript) {
            throw '检测到app.tsx，请使用typescript模式编译(-t/--typescript)';
        }
        injectBuildEnv({
            platform,
            compress,
            huawei,
            typescript
        });

        getWebViewRules();

        await runBeforeParseTasks({ platform, beta, betaUi, compress });

        if (compress) {
            // 添加代码压缩loader
            postLoaders.unshift('nanachi-compress-loader');
        }

        const webpackConfig: webpack.Configuration = getWebPackConfig({
            platform,
            compress,
            compressOption,
            beta,
            betaUi,
            plugins,
            typescript,
            analysis,
            prevLoaders,
            postLoaders,
            prevJsLoaders,
            postJsLoaders,
            prevCssLoaders,
            postCssLoaders,
            rules,
            huawei
            // maxAssetSize
        });
        const compiler = webpack(webpackConfig);

        if (watch) {
            compiler.watch({}, callback);
        } else {
            compiler.run(callback);
        }
    } catch (err) {
        callback(err);
    }
}

function injectBuildEnv({ platform, compress, huawei, typescript }: NanachiOptions) {
    process.env.ANU_ENV = (platform === 'h5' ? 'web' : platform);
    globalConfig['buildType'] = platform;
    globalConfig['compress'] = compress;
    globalConfig['typescript'] = typescript;
    if (platform === 'quick') {
        globalConfig['huawei'] = huawei || false;
    }
}

function showLog() {
    if ( utils.isMportalEnv() ) {
        let log = '';
        while (buildLog.length) {
            log += buildLog.shift() + (buildLog.length !== 0 ? '\n' : '');
        }
        // eslint-disable-next-line
        console.log(log);
    }
    while (warning.length) {
        warningLog(warning.shift());
    }
    
    if (error.length) {
        error.forEach(function(error: Log){
            errorLog(error);
        });
        if ( utils.isMportalEnv() ) {
            process.exit(1);
        }
    }
}

/**
 * **getWebViewRoutes**
 * 适配 windows, 找到 page: true 的页面路径
 * 
 * [webview 配置链接地址](https://rubylouvre.github.io/nanachi/documents/webview.html)
 * 
 * ``` js
 * static config = {
 *     webview: {
 *         quick: {
 *             pages: true
 *         }
 *     }
 * }
 * ```
 */
function getWebViewRoutes(): string[]{
    const pages = path.join(process.cwd(), 'source', 'pages');
    let webViewRoutes: string[] = [];
    if('win32' === OS.platform()){
        webViewRoutes = rd.readFilterSync(pages, /\.js$/).filter((jsfile: string) => {
            const reg = new RegExp("pages:\\s*(\\btrue\\b|\\[.+\\])");
            const content: string = fs.readFileSync(jsfile).toString();
            return reg.test(content);
        });
    } else {
        /**
         * 如果不是 win 平台,保留原有逻辑
         */
        let bin = 'grep';
        let opts = ['-r', '-E', "pages:\\s*(\\btrue\\b|\\[.+\\])", pages];
        let ret = spawn(bin, opts).stdout.toString().trim();

        webViewRoutes = ret.split(/\s/)
            .filter(function (el) {
                return /\/pages\//.test(el)
            }).map(function (el) {
                return el.replace(/\:$/g, '')
            });
    }
    return webViewRoutes;
}

//获取 WEBVIEW 配置
function getWebViewRules() {
    const cwd = process.cwd();
    if (globalConfig.buildType != 'quick') return;
    let webViewRoutes = getWebViewRoutes();

    webViewRoutes.forEach(async function (pagePath) {
        babel.transformFileSync(pagePath, {
            configFile: false,
            babelrc: false,
            comments: false,
            ast: true,
            presets: [
                require('@babel/preset-react')
            ],
            plugins: [
                [require('@babel/plugin-proposal-decorators'), { legacy: true }],
                [require('@babel/plugin-proposal-class-properties'), { loose: true }],
                require('@babel/plugin-proposal-object-rest-spread'),
                require('@babel/plugin-syntax-jsx'),
                require('./packages/babelPlugins/collectWebViewPage'),
            ]
        });
    });

    const WebViewRules: any = globalConfig.WebViewRules;
    if (WebViewRules && WebViewRules.pages.length) {
        process.env.ANU_WEBVIEW = 'need_require_webview_file';
    } else {
        process.env.ANU_WEBVIEW = '';
    }

}
//module.exports = nanachi;
export default nanachi;