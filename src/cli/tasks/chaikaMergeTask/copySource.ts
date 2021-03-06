import fs from 'fs-extra';
import glob from 'glob';
import * as path from 'path';
const cwd = process.cwd();
const downLoadDir = path.join(cwd, '.CACHE/download');
const mergeDir = path.join(cwd, '.CACHE/nanachi');
const mergeFilesQueue = require('./mergeFilesQueue');
//这些文件对项目编译时来说，没啥用
const ignoreFiles: any = [
    'package-lock.json'
];

const ignoreExt = ['.tgz', '.log', 'rpks'];

const docFilesReg = /\.md$/;
const configFileReg = /\w+Config\.json$/;
const reactFileReg = /React\w+\.js$/;

//这些文件需要经过其他处理
const mergeFiles: any = [
    'app.json',
    'app.js',
    // 'app.tsx',
    'package.json'
];

//这种文件全局只能有一个, 不参与合并
const lockFiles: any = [
    'project.config.json'
];



function isIgnoreFile(fileName: string){
    return ignoreFiles.includes(fileName) 
        || mergeFiles.includes(fileName)
        || lockFiles.includes(fileName)
        || ignoreExt.includes(path.parse(fileName).ext)
        || configFileReg.test(fileName)
        || reactFileReg.test(fileName)
        || docFilesReg.test(fileName)
}

function isMergeFile(fileName: string){
    return mergeFiles.includes(fileName)
        || configFileReg.test(fileName);
}

function isLockFile(fileName: string) {
    return lockFiles.includes(fileName);
}

function copyCurrentProject(): Promise<any> {

    // 如果当前目录不存在source目录，并且不存不存在app.js, 那可能是个非nanachi工程目录
    
    if (
        !fs.existsSync(path.join(cwd, 'source'))
        && !fs.existsSync(path.join(cwd, 'app.js'))
    ) {
        return Promise.resolve(1);
    }
    
    let projectDirName = cwd.replace(/\\/g, '/').split('/').pop();
    let files = glob.sync( './!(node_modules|dist|src|sign|build|.CACHE|.chaika_cache|nanachi)', {
        //nodir: true
    });
    let allPromiseCopy = files
    // .filter((file) => {
    //     return isIgnoreFile(path.basename(file)) ? false : true;
    // })
    .map(function(el){
        let src = path.join(cwd, el);
        let dist = path.join(downLoadDir, projectDirName, el);
        if (/\.\w+$/.test(el)) {
            fs.ensureFileSync(dist);
            return fs.copyFile(src, dist);
        } else {
            fs.ensureDirSync(dist);
            return fs.copy(src, dist);
        }
    });
    return Promise.all(allPromiseCopy);
}

function copyOtherProject() {
    let files = glob.sync( downLoadDir + '/**', {nodir: true});
    files = files.filter((file)=>{
        let fileName = path.parse(file).base;
        if (isIgnoreFile(fileName)) {
            if (isMergeFile(fileName) || isLockFile(fileName) ) {
                mergeFilesQueue.add(file);
            }
            return false;
        } else {
            return true;
        }
    });

    let allPromiseCopy = files.map(function(file){
        let dist = '';
        file = file.replace(/\\/g, '/');
        if (/\/source\//.test(file)) {
            dist = path.join(mergeDir, 'source', file.split('/source/').pop());
        } else {
            dist = path.join(mergeDir, file.split('/').pop());
        }
        fs.ensureFileSync(dist);
        return fs.copyFile(file, dist);
    });
   
    return Promise.all(allPromiseCopy);
}

export default function(){
    fs.emptyDirSync(mergeDir);
    return copyCurrentProject()
        .then(function(){
            return copyOtherProject();
        })
        .then(function(){
            return Promise.resolve(1);
        })
        .catch(function(err){
            return Promise.reject(err);
        });
};