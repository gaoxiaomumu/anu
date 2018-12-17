/* eslint no-console: 0 */
const fs = require('fs');
const postCss = require('postcss');
const validateStyle = require('../validateStyle');
const utils = require('../utils');

//postcss插件: 清除注释
const postCssRemoveComments = postCss.plugin('postcss-plugin-remove-comment', ()=>{
    return (root)=>{
        root.walkComments(comment => {
            comment.remove();
        });
    };
});

const postCssPluginLessVar = postCss.plugin('postcss-plugin-less-var', ()=>{
    const variables = {};
    return (root) => {
        root.walkAtRules(rule => {
            if (rule.variable) {
                variables[rule.name] = rule.value;
                rule.remove();
            }
        });
        root.walkDecls(function(decl) {
            if (decl.value && decl.value.match(/(@{?[a-zA-Z0-9-_.]+}?)/g)) {
                
                const key = decl.value.split('@')[1];
                decl.value = variables[key];
            }
        });
    };
});

const compileLessByPostCss = (filePath, originalCode)=>{
    return new Promise((resolved, reject)=>{
        postCss([
            require('postcss-import')({
                resolve(importer, baseDir){
                    //如果@import的值没有文件后缀
                    if (!/\.less/.test(importer)) {
                        importer = importer + '.less';
                    }
                    //处理alias路径
                    return utils.resolveStyleAlias(importer, baseDir);
                }
            }),
            postCssRemoveComments,
            postCssPluginLessVar,
            require('postcss-nested-props'),   //属性嵌套
            require('postcss-automath')       //5px + 2 => 7px
            
        ])
            .process(
                originalCode || fs.readFileSync(filePath).toString(),
                {
                    from: filePath,   
                    parser: require('postcss-less'),
                }
            )
            .then((result)=>{
                let code = validateStyle(result.css);
                resolved({
                    code: code
                });
            })
            .catch((err)=>{
                reject(err);
            });
    });
    
};



module.exports = compileLessByPostCss;
