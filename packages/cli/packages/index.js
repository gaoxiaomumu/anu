/* eslint no-console: 0 */

const chalk = require('chalk');
const path = require('path');
const rollup = require('rollup');
const rbabel = require('rollup-plugin-babel');
const resolve = require('rollup-plugin-node-resolve');
const commonjs = require('rollup-plugin-commonjs');
const rollupLess = require('rollup-plugin-less');
const rollupJson = require('rollup-plugin-json');
const rollupSass = require('rollup-plugin-sass');
const alias = require('rollup-plugin-alias');
const chokidar = require('chokidar');
const fs = require('fs-extra');
const utils = require('./utils');
const queue = require('./queue');
const crypto = require('crypto');
const miniTransform = require('./miniTransform');
const styleTransform = require('./styleTransform');
const resolveNpm = require('./resolveNpm');
const generate = require('./generate');
let cwd = process.cwd();
let inputPath = path.join(cwd, 'src');
let entry = path.join(inputPath, 'app.js');
let cache = {};

//缓存
let needUpdate = (id, code) => {
    let sha1 = crypto
        .createHash('sha1')
        .update(code)
        .digest('hex');
    return new Promise((resolve, reject) => {
        if (!cache[id] || cache[id] != sha1) {
            cache[id] = sha1;
            resolve(1);
        } else {
            reject(0);
        }
    });
};

const isNpm = path => {
    return /\/node_modules\//.test(path);
};
const isStyle = path => {
    return /\.(?:less|scss|sass)$/.test(path);
};

const isJs = path => {
    return /\.js$/.test(path);
};

class Parser {
    constructor(entry) {
        this.entry = entry;
        this.jsFiles = [];
        this.styleFiles = [];
        this.npmFiles = [];
        this.jsonFiles = [];
        this.customAliasConfig = utils.getCustomAliasConfig();

        this.inputConfig = {
            input: this.entry,
            plugins: [
                alias(this.customAliasConfig), //搜集依赖时候，能找到对应的alias配置路径
                resolve({
                    jail: path.join(cwd), //从项目根目录中搜索npm模块, 防止向父级查找
                    preferBuiltins: false,
                    customResolveOptions: {
                        moduleDirectory: path.join(cwd, 'node_modules')
                    }
                }),
                commonjs({
                    include: 'node_modules/**'
                }),
                rollupLess({
                    output: function() {
                        return '';
                    }
                }),
                rollupJson(),
                rollupSass(),
                rbabel({
                    babelrc: false,
                    runtimeHelpers: true,
                    presets: ['react'],
                    externalHelpers: false,
                    plugins: [
                        'transform-class-properties',
                        'transform-object-rest-spread',
                        'transform-es2015-template-literals'
                    ]
                })
            ],
            onwarn: warning => {
                //warning.importer 缺失依赖文件路径
                //warning.source   依赖的模块名
                if (warning.code === 'UNRESOLVED_IMPORT') {
                    if (this.customAliasConfig[warning.source.split('/')[0]])
                        return;
                    console.log(chalk.red(`缺少${warning.source}, 请检查`));
                }
            }
        };

        
        
    }
    async parse() {
        let spinner = utils.spinner('正在分析依赖...');
        spinner.start();
        const bundle = await rollup.rollup(this.inputConfig);
        spinner.succeed('依赖分析成功');
        bundle.modules.forEach(item => {
            const id = item.id;
            if (/commonjsHelpers/.test(id)) {
                return;
            }
            if (isNpm(id)) {
                this.npmFiles.push({
                    id: id,
                    originalCode: item.originalCode
                });
                return;
            }
            if (isStyle(id)) {
                this.styleFiles.push({
                    id: id,
                    originalCode: item.originalCode
                });
                return;
            }

            if (/\.json$/.test(id)) {
                this.jsonFiles.push({
                    id: id,
                    originalCode: item.originalCode
                });
                return;
            }

            if (isJs(id)) {
                this.jsFiles.push({
                    id: id,
                    originalCode: item.originalCode,
                    resolvedIds: this.filterNpmModule(item.resolvedIds) //处理路径alias配置
                });
                return;
            }

        });
        this.transform();
        this.copyAssets();
        
    }
    filterNpmModule(resolvedIds) {
        let result = {};
        Object.keys(resolvedIds).forEach(key => {
            if (utils.isNpm(key)) {
                result[key] = resolvedIds[key];
            }
        });
        return result;
    }
    transform() {
        this.updateJsQueue(this.jsFiles);
        this.updateStyleQueue(this.styleFiles);
        this.updateNpmQueue(this.npmFiles);
        this.updateJsonQueue(this.jsonFiles);
    }
    checkComponentsInPages(id) {
        let flag = false;
        let pathAray = utils.isWin() ? id.split('\\') :  id.split('/'); //分割目录
        let componentsPos = pathAray.indexOf('components');
        let pagesPos = pathAray.indexOf('pages');
        if (componentsPos != -1 && pagesPos!=-1 && componentsPos > pagesPos ) {
            flag = true;
        }
        return flag;
    }
    updateJsQueue(jsFiles) {
        while (jsFiles.length) {
            let { id, originalCode, resolvedIds } = jsFiles.shift();
            
            if (this.checkComponentsInPages(id)) {
                // eslint-disable-next-line
                console.log(
                    chalk.red(
                        JSON.stringify(
                            {
                                path: id,
                                msg: 'components目录不能存在于pages目录下, 请检查'
                            },
                            null,
                            4
                        )
                    )
                );
            }

            needUpdate(id, originalCode)
                .then(() => {
                    miniTransform.transform(id, resolvedIds);
                })
                .catch(() => {});
        }
    }
    updateStyleQueue(styleFiles) {
        let result = utils.resolveComponentStyle(styleFiles);
        while (result.length) {
            let data = result.shift();
            let { id, originalCode } = data;
            needUpdate(id, originalCode)
                .then(() => {
                    styleTransform(data);
                })
                .catch(() => {});
        }
    }
    updateNpmQueue(npmFiles) {
        while (npmFiles.length) {
            let item = npmFiles.shift();
            // rollup 处理 commonjs 模块时候，会在 id 加上 commonjs-proxy: 前缀
            if (/commonjs-proxy:/.test(item.id)) {
                item.id = item.id.split(':')[1];
                item.moduleType = 'cjs';
            } else {
                item.moduleType = 'es';
            }
            // 处理所有 npm 模块中其他依赖
            needUpdate(item.id, item.originalCode)
                .then(() => {
                    resolveNpm(item);
                })
                .catch(() => {});
        }
    }
    updateJsonQueue(jsonFiles) {
        while (jsonFiles.length){
            let item = jsonFiles.shift();
            needUpdate(item.id, item.originalCode)
                .then(() => {
                    queue.push({
                        path: item.id.replace(/\/src\//, '/dist/'),
                        code: item.originalCode,
                        type: 'json'
                    });
                    utils.emit('build');
                })
                .catch(() => {});
        }
    }
    copyAssets() {
        //to do 差异化copy
        const dir = 'assets';
        const inputDir = path.join(inputPath, dir);
        const distDir = path.join(path.join(cwd, 'dist'), dir);
        fs.ensureDirSync(distDir);
        fs.copy(inputDir, distDir, err => {
            if (err) {
                console.error(err);
            }
        });
        
    }
    watching() {
        let watchDir = path.dirname(this.entry);
        let watchConfig = {
            ignored: /\.DS_Store|\.gitignore|\.git/,
            awaitWriteFinish: {
                stabilityThreshold: 700,
                pollInterval: 100
            }
        };
        const watcher = chokidar
            .watch(watchDir, watchConfig)
            .on('change', (file)=>{
                console.log(
                    `\n更新: ${chalk.yellow(path.relative(cwd, file))}\n`
                );
                this.inputConfig.input = file;
                this.parse();
                
            });
        watcher.on('error', error => {
            console.error('Watcher failure', error);
            process.exit(1);
        });
    }
}

utils.on('build', ()=>{
    generate();
});


async function build(arg) {
    //同步react
    await utils.asyncReact();
    const parser = new Parser(entry);
    await parser.parse();
    if (arg === 'watch') {
        parser.watching();
    }
    
}

module.exports = build;