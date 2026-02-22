
import * as fs from "fs"
import * as Path from "path"

//process.exit(0);

/**
* @param {string} path
* @param {number|undefined} depth
*/
function* iterateFiles(path :string, depth : number|undefined =undefined) : Iterable<string> {
    if (depth && depth<0) return;
    const files = fs.readdirSync(path);
    for(let file of files) {
        let filePath= Path.resolve(path, file);
        //console.log(file, fs.statSync(filePath).isDirectory());
        if (fs.lstatSync(filePath).isDirectory())
            yield* iterateFiles(filePath, depth!=undefined ? depth-1 : undefined);
        yield filePath;
    }
}


/**
* @param {string} path
* @param {string} importPath
* @param {{skipFiles :string[]|undefined}|undefined} params
*/
async function testImports(path :string, importPath=path, params? :{skipFiles :string[]|undefined}) {

    for(let file of iterateFiles(path)) {
        console.log(file);
        let relativeFile= Path.relative(path, file);
        //console.log("rel:",relativePath);
        //continue;
        let ok= (()=> {
            for(let skipFile of params?.skipFiles ?? []) {
                let myFile= file;
                if (! (skipFile.includes("/") || skipFile.includes("\\")))
                    myFile= Path.basename(file);
                if (myFile===skipFile) return false;
            }
            return true;
        })();
        if (!ok) continue;
        //if (params?.skipFiles?.includes(file)) continue;
        let ext= Path.parse(file).ext;
        if (ext===".js" || ext===".mjs") {
            let importFile= Path.join(importPath, relativeFile).replaceAll("\\", "/");
            //file= "file:///"+file;
            console.log("import ",importFile);
            await import(importFile);
        }
    }
}

console.log("=====");
//let path= "./dist";
//console.log(Path.relative("wenay",Path.resolve("wenay", "myFile")));
testImports("./lib", "wenay-common", {skipFiles: ["index.js", "client.js", "server.js"]});

