#!/usr/bin/env node

(function(global) {

var USAGE = _multiline(function() {/*
    Usage:
        node Minify.js [@label ...]
                       [--help]
                       [--verbose]
                       [--nowrap]
                       [--nocompile]
                       [--header file]
                       [--footer file]
                       [--es5in]
                       [--es6in]
                       [--es5out]
                       [--es6out]
                       [--keep]
                       [--simple]
                       [--strict]
                       [--pretty]
                       [--option "compile option"]
                       [--extern file]
                       [--label @label]
                       [--release]

    See:
        https://github.com/uupaa/Minify.js/wiki/Minify
*/});

var ERR  = "\u001b[31m"; // RED
var WARN = "\u001b[33m"; // YELLOW
var INFO = "\u001b[32m"; // GREEN
var CLR  = "\u001b[0m";  // WHITE

var fs = require("fs");
var cp = require("child_process");
var argv = process.argv.slice(2);
var wmlib = process.argv[1].split("/").slice(0, -2).join("/") + "/lib/"; // "WebModule/lib/"
var mod = require(wmlib + "Module.js");
var pkg = JSON.parse(fs.readFileSync("./package.json"));
var wm = pkg.webmodule;
var Task = require(wmlib + "Task.js");
var target = mod.collectBuildTarget(pkg);

var options = _parseCommandLineOptions({
        name:       pkg.name,       // Object       - { git:String, npm:String }. github repository name, npm package name.
        help:       false,          // Boolean      - true is show help.
        keep:       false,          // Boolean      - keep tmp file.
        label:      ["dev", "debug", "assert"], // LabelStringArray
        nowrap:     false,          // Boolean      - false -> wrap WebModule idiom.
        header:     "",             // PathString   - header file.
        footer:     "",             // PathString   - footer file.
        es5in:      false,          // Boolean      - input ES5 code.
        es6in:      false,          // Boolean      - input ES6 code.
        es5out:     false,          // Boolean      - output ES5 code.
        es6out:     false,          // Boolean      - output ES6 code.
        strict:     false,          // Boolean      - true -> add 'use strict'.
        pretty:     false,          // Boolean      - true -> pretty print.
        option:     [],             // OptionStringArray - ["language_in ECMASCRIPT5_STRICT", ...]
        compile:    true,           // Boolean      - true -> compile.
        release:    false,          // Boolean      - true -> release build, use NodeModule.files().
        externs:    [],             // FilePathArray- ["externs-file-name", ...]
        verbose:    false,          // Boolean      - true -> verbose mode.
        workDir:    "release/",     // PathString   - work dir.
        advanced:   true            // Boolean      - true -> ADVANCED_OPTIMIZATIONS MODE.
    });

if (options.help) {
    console.log(WARN + USAGE + CLR);
    return;
}

// --- detect work dir ---
if (!target.all.output) {
    console.log(ERR + "package.json - webmodule.{browser|worker|node|all}.output are empty." + CLR);
    return;
}
if (target.all.output.indexOf("/") > 0) {
    // "release/Zzz.min.js" -> "release/";
    options.workDir = (target.all.output.split("/").slice(0, -1)).join("/") + "/";
}

// $ npm run build は、package.json の webmodule.{browser|worker|node|all}.source をビルドします
// $ npm run build.release は、webmodule.{browser|worker|node|all}.source に加え node_modules 以下の依存ファイルもビルドします
var browserSource = target.browser.source;
var workerSource  = target.worker.source;
var nodeSource    = target.node.source;
var allSource     = target.all.source;

if (options.release) {
    // 依存関係にあるソース(deps.files.{browser|worker|node|all})を取得する
    var deps = mod.getDependencies(options.release);

    if (options.verbose) {
        console.log("\u001b[33m" + "deps.files.browser: " + JSON.stringify(deps.files.browser, null, 2) + "\u001b[0m");
        console.log("\u001b[33m" + "deps.files.worker: "  + JSON.stringify(deps.files.worker, null, 2) + "\u001b[0m");
        console.log("\u001b[33m" + "deps.files.node: "    + JSON.stringify(deps.files.node, null, 2) + "\u001b[0m");
        console.log("\u001b[33m" + "deps.files.all: "     + JSON.stringify(deps.files.all, null, 2) + "\u001b[0m");
    }

    // ソースコードをマージし重複を取り除く
    browserSource = mod.toUniqueArray([].concat(deps.files.browser, browserSource));
    workerSource  = mod.toUniqueArray([].concat(deps.files.worker,  workerSource));
    nodeSource    = mod.toUniqueArray([].concat(deps.files.node,    nodeSource));
    allSource     = mod.toUniqueArray([].concat(deps.files.all,     allSource));

    if (options.verbose) {
        console.log("Release build source: " + JSON.stringify(browserSource, null, 2));
        console.log("Release build source: " + JSON.stringify(workerSource, null, 2));
        console.log("Release build source: " + JSON.stringify(nodeSource, null, 2));
        console.log("Release build source: " + JSON.stringify(allSource, null, 2));
    }
}

if (!_isFileExists(options.externs) ||
    !_isFileExists(browserSource) ||
    !_isFileExists(workerSource) ||
    !_isFileExists(nodeSource) ||
    !_isFileExists(allSource)) {
    console.log(WARN + USAGE + CLR);
    return;
}
if (options.verbose) {
    console.log("browserSource = " + browserSource);
    console.log("workerSource = " + workerSource);
    console.log("nodeSource = " + nodeSource);
    console.log("allSource = " + allSource);
}

var minifyOptions = {
    "keep":         options.keep,
    "label":        options.label,
    "nowrap":       options.nowrap,
    "header":       options.header,
    "footer":       options.footer,
    "es5in":        options.es5in,
    "es6in":        options.es6in,
    "es5out":       options.es5out,
    "es6out":       options.es6out,
    "strict":       options.strict,
    "pretty":       options.pretty,
    "option":       options.option,
    "compile":      options.compile,
    "externs":      options.externs,
    "verbose":      options.verbose,
    "workDir":      options.workDir,
    "advanced":     options.advanced
};

// --- コンパイル対象を決定する ---
// できるだけ無駄なコンパイルは避ける
// コンパイル対象のソースコードがbrowser,worker,node,allで同じ場合は一度だけ(allだけを)コンパイルする
// allとbrowser,worker,node が異なる場合は、それぞれの環境に向けて特殊化したビルドを行う
// browserとworkerが同じ場合は、browser用のファイルをworkerにコピーして使用する
// browserとnodeが同じ場合は、browser用のファイルをnodeにコピーして使用する
var taskPlan = [];
var copyBrowserFileToWorkerFile = false; // browser用のビルドをコピーしworkerとしても使用する
var copyBrowserFileToNodeFile   = false; // browser用のビルドをコピーしnodeとしても使用する

if (allSource.length) { taskPlan.push("all"); }
// all と {browser|worker|node} のファイル構成が異なる場合は個別にビルドを行う
if (browserSource.length && allSource.join() !== browserSource.join()) { taskPlan.push("browser"); }
if (workerSource.length  && allSource.join() !== workerSource.join())  { taskPlan.push("worker");  }
if (nodeSource.length    && allSource.join() !== nodeSource.join())    { taskPlan.push("node");    }
// browserとworkerのファイル構成が一緒の場合はまとめてしまい、workerのビルドを省略する
if (taskPlan.indexOf("browser") >= 0 && taskPlan.indexOf("worker") >= 0) {
    if (browserSource.join() === workerSource.join()) {
        copyBrowserFileToWorkerFile = true;
        taskPlan = taskPlan.filter(function(target) { return target !== "worker"; });
    }
}
// browserとnodeのファイル構成が一緒の場合はまとめてしまい、nodeのビルドを省略する
if (taskPlan.indexOf("browser") >= 0 && taskPlan.indexOf("node") >= 0) {
    if (browserSource.join() === nodeSource.join()) {
        copyBrowserFileToNodeFile = true;
        taskPlan = taskPlan.filter(function(target) { return target !== "node"; });
    }
}

if (options.verbose) {
    console.log("Compile task planning: " + taskPlan.join(" and "));
}

Task.run(taskPlan.join(" > "), {
    "all": function(task) {
        Minify(browserSource, minifyOptions, function(err, js) {
            if (err) {
                task.miss();
            } else {
                fs.writeFileSync(target.all.output, js);
                fs.writeFileSync(target.browser.output, js);
                fs.writeFileSync(target.worker.output, js);
                fs.writeFileSync(target.node.output, js);
                task.pass();
            }
        });
    },
    "browser": function(task) {
        if (options.verbose) {
            console.log("begin browser task...");
        }
        Minify(browserSource, minifyOptions, function(err, js) {
            if (err) {
                task.miss();
            } else {
                fs.writeFileSync(target.browser.output, js);
                if (copyBrowserFileToWorkerFile) {
                    fs.writeFileSync(target.worker.output, js);
                }
                if (copyBrowserFileToNodeFile) {
                    fs.writeFileSync(target.node.output, js);
                }
                task.pass();
            }
        });
    },
    "worker": function(task) {
        if (options.verbose) {
            console.log("begin worker task...");
        }
        Minify(workerSource, minifyOptions, function(err, js) {
            if (err) {
                task.miss();
            } else {
                fs.writeFileSync(target.worker.output, js);
                task.pass();
            }
        });
    },
    "node": function(task) {
        if (options.verbose) {
            console.log("begin node task...");
        }
        Minify(nodeSource, minifyOptions, function(err, js) {
            if (err) {
                task.miss();
            } else {
                fs.writeFileSync(target.node.output, js);
                task.pass();
            }
        });
    }
}, function(err) {
    if (err) {
        if (options.verbose) {
            console.log(ERR + "failed." + CLR);
            process.exit(1);
        }
    } else {
        if (options.verbose) {
            console.log("All compilation task has ended.");
        }
    }
});

function _isFileExists(fileList) { // @arg Array
                                   // @ret Boolean
    return fileList.every(function(file) {
        if (!fs.existsSync(file)) {
            console.log(ERR + "File not found: " + file + CLR);
            return false;
        }
        return true;
    });
}

function _parseCommandLineOptions(options) {
    for (var i = 0, iz = argv.length; i < iz; ++i) {
        switch (argv[i]) {
        case "-h":
        case "--help":      options.help = true; break;
        case "-v":
        case "--verbose":   options.verbose = true; break;
        case "--nowrap":    options.nowrap = true; break;
        case "--nocompile": options.compile = false; break;
        case "--header":    options.header = fs.readFileSync(argv[++i], "utf8"); break;
        case "--footer":    options.footer = fs.readFileSync(argv[++i], "utf8"); break;
        case "--es5in":     options.es5in = true; break;
        case "--es6in":     options.es6in = true; break;
        case "--es5out":    options.es5out = true; break;
        case "--es6out":    options.es6out = true; break;
        case "--strict":    options.strict = true; break;
        case "--pretty":    options.pretty = true; break;
        case "--keep":      options.keep = true; break;
        case "--simple":    options.advanced = false; break;
        case "--extern":
        case "--externs":   _pushif(options.externs, argv[++i]); break;
        case "--option":    _pushif(options.option, argv[++i]); break;
        case "--module":
        case "--release":   options.release = true; break;
        case "--label":     _pushif(options.label, argv[++i].replace(/^@/, "")); break;
        default:
            if ( /^@/.test(argv[i]) ) { // @label
                _pushif(options.label, argv[i].replace(/^@/, ""));
            } else {
                throw new Error("Unknown option: " + argv[i]);
            }
        }
    }
    return options;
}

function _pushif(source, value) {
    if (source.indexOf(value) < 0) { // avoid duplicate
        source.push(value);
    }
}

function _multiline(fn) { // @arg Function
                          // @ret String
    return (fn + "").split("\n").slice(1, -1).join("\n");
}















// Closure Compiler Service
//  http://closure-compiler.appspot.com/home

// --- dependency modules ----------------------------------

// --- define / local variables ----------------------------
//var _runOnNode = "process" in global;
//var _runOnWorker = "WorkerLocation" in global;
//var _runOnBrowser = "document" in global;

var OUTPUT_FILE   = "./.Minify.output.js";
var TMP_FILE      = "./.Minify.tmp.js";

// --- class / interfaces ----------------------------------
function Minify(sources, // @arg StringArray - JavaScript sources file path. [path, ...]
                options, // @arg Object = null - { keep, label, nowrap, header, footer, es5in, es6in, es5out, es6out, strict, pretty, option, compile, externs, verbose, workDir, advanced }
                         // @options.keep       Boolean = false  - keep temporary file.
                         // @options.label      LabelStringArray = null - ["@label", ...]
                         // @options.nowrap     Boolean = false  - false is wrap WebModule idiom.
                         // @options.header     String = ""      - Header part extras JavaScript expression string.
                         // @options.footer     String = ""      - Footer part extras JavaScript expression string.
                         // @options.es5in      Boolean = false  - input ES5 code.
                         // @options.es6in      Boolean = false  - input ES6 code.
                         // @options.es5out     Boolean = false  - output ES5 code.
                         // @options.es6out     Boolean = false  - output ES6 code.
                         // @options.strict     Boolean = false  - true is add 'use strict'.
                         // @options.pretty     Boolean = false  - true is pretty strict.
                         // @options.option     StringArray = [] - ClosureCompiler additional options string.
                         // @options.compile    Boolean = false  - true is compile. false is concat files.
                         // @options.externs    StringArray = [] - Clouser Compiler externs definition file path
                         // @options.verbose    boolean = false  - true is verbose mode.
                         // @options.workDir    String = ""      - work dir.
                         // @options.advanced   Boolean = false  - true is advanced build mode
                fn) {    // @arg Function = null - callback function. fn(err:Error, result:String)
//{@dev
    _if(!Array.isArray(sources), Minify, "sources");
    if (options) {
        _if(options.constructor !== ({}).constructor, Minify, "options");
        _if(!_keys(options, "keep,label,nowrap,header,footer,es5in,es6in,es5out,es6out,strict,pretty,option,compile,externs,verbose,workDir,advanced"), Minify, "options");
    }
    if (fn) {
        _if(typeof fn !== "function", Minify, "fn");
    }
//}@dev

    var optionsString = _makeClouserCompilerOptions(options);

    if (options.compile) {
        cp.exec("which -s closure-compiler", function(err) {
                // $ node install uupaa.compile.js
                _offlineMinificationNode(sources, options, optionsString, fn);
        });
    } else {
        // debug build, concat and preprocess only.
        _noMinification(sources, options, fn);
    }
}

// --- implements ------------------------------------------
function _makeClouserCompilerOptions(options) { // @arg Object - { keep, nowrap, ... }. see Minify()
                                                // @ret String - "--option value ..."
    var result = [];

  //result["transform_amd_modules"] = "";
  //result["create_source_map"] = "source.map";

    if (options.advanced) {
        result.push("--compilation_level ADVANCED_OPTIMIZATIONS");
        if (options.externs && options.externs.length) {
            result.push("--externs " + options.externs.join(" --externs "));
        }
    } else {
        result.push("--compilation_level SIMPLE_OPTIMIZATIONS");
    }
    if (!options.nowrap) { // wrap WebModule idiom
        result.push("--output_wrapper '(function(global){\n%output%\n})((this||0).self||global);'");
    }

    if (options.strict) {
        if (options.es5in) {
            result.push("--language_in ECMASCRIPT5_STRICT");
        } else if (options.es6in) {
            result.push("--language_in ECMASCRIPT6_STRICT");
        } else { // back compat
            result.push("--language_in ECMASCRIPT5_STRICT");
        }
        if (options.es5out) {
            result.push("--language_out ECMASCRIPT5_STRICT");
        } else if (options.es6out) {
            result.push("--language_out ECMASCRIPT6_STRICT");
        }
    } else {
        if (options.es5in) {
            result.push("--language_in ECMASCRIPT5");
        } else if (options.es6in) {
            result.push("--language_in ECMASCRIPT6");
        } else { // back compat
            result.push("--language_in ECMASCRIPT5");
        }
        if (options.es5out) {
            result.push("--language_out ECMASCRIPT5");
        } else if (options.es6out) {
            result.push("--language_out ECMASCRIPT6");
        }
    }
    if (options.pretty) {
        result.push("--formatting pretty_print");
    }
    if (options.option.length) {
        result.push("--" + optionsObject.option.join(" --"));
    }
    return result.join(" ");
}

function _offlineMinificationNode(sources,       // @arg StringArray - JavaScript SourceCode file path. [path, ...]
                                  options,       // @arg Object - { keep, nowrap, ... }. see Minify()
                                  optionsString, // @arg String
                                  callback) {    // @arg Function = null - callback(err:Error, result:String)

    var js = (options.header || "") + _concatFiles(sources) + (options.footer || "");

    if (options.label && options.label.length) {
        js = Minify_preprocess(js, options.label);
    }
    fs.writeFileSync(options.workDir + TMP_FILE, js);

    if (options.verbose) {
        console.log(INFO + "Compile options: \n  " + optionsString.replace(/\n/g, "") + CLR);
    }

    // `npm install -g uupaa.compile.js`
    var compile = require("uupaa.compile.js");

    compile.exec(options.workDir + TMP_FILE,
                 options.workDir + OUTPUT_FILE,
                 optionsString,
                 function(err, stdout, stderr) {
        if (err || stderr) {
            console.log(stderr);
            if (callback) {
                callback(new Error(stderr), "");
            }
        } else {
            var minifiedCode = fs.readFileSync(options.workDir + OUTPUT_FILE, "utf8");

            fs.unlinkSync(options.workDir + OUTPUT_FILE);
            if (!options.keep) {
                fs.unlinkSync(options.workDir + TMP_FILE);
            }
            if (callback) {
                callback(null, minifiedCode);
            }
        }
    });
}

function Minify_preprocess(js,       // @arg String - JavaScript expression string.
                           labels) { // @arg StringArray - strip labels. ["label", ...]
//{@dev
    _if(typeof js !== "string", Minify_preprocess, "js");
    _if(!Array.isArray(labels), Minify_preprocess, "labels");
//}@dev

    // normalize line feed.
    js = js.replace(/(\r\n|\r|\n)/mg, "\n");

    // trim code block.
    js = _trimCodeBlock(js, labels);

    return js;
}

function _noMinification(sources, // @arg StringArray - JavaScript SourceCode file path. [path, ...]
                         options, // @arg Object - { keep, nowrap, ... } see Minify()
                         fn) {    // @arg Function = null - callback function. fn(err:Error, result:String)

    var js = (options.header || "") + _concatFiles(sources) + (options.footer || "");

    if (options.label && options.label.length) {
        js = Minify_preprocess( js, options.label );
    }
    if (fn) {
        fn(null, js);
    }
}

function _trimCodeBlock(js,       // @arg String - JavaScript expression string.
                        labels) { // @arg StringArray - [label, ...]
                                  // @ret String
    return labels.reduce(function(js, label) {
        // trim:
        //
        // {@label ... }@label
        //
        var line  = RegExp("\\{@" + label + "\\b(?:[^\\n]*)\\}@" +
                                    label + "\\b", "g");

        // trim:
        //
        // {@label
        //   ...
        // }@label
        //
        var lines = RegExp("\\{@" + label + "\\b(?:[^\\n]*)\n(?:[\\S\\s]*?)?\\}@" +
                                    label + "\\b", "g");

        return js.replace(line, " ").replace(lines, " ");
    }, js);
}

function _concatFiles(sources) { // @arg FilePathArray
                                 // @ret String
    return sources.map(function(path) {
        if (fs.existsSync(path)) {
            return fs.readFileSync(path, "utf8");
        }
        console.log(path + " is not exists");
        return "";
    }).join("");
}

// --- validate / assertions -------------------------------
//{@dev
function _keys(value, keys) {
    var items = keys.split(",");

    return Object.keys(value).every(function(key) {
        return items.indexOf(key) >= 0;
    });
}

function _if(value, fn, hint) {
    if (value) {
        throw new Error(fn.name + " " + hint);
    }
}
//}@def

})((this || 0).self || global);

