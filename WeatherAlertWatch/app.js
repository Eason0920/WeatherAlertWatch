var fs = require('fs'),
    util = require('util'),
    chokidar = require('chokidar'),
    xpath = require('xpath'),
    xmlParse = require('xmldom').DOMParser,
    moment = require('moment'),
    padLeft = require('lodash.padleft'),
    lock = new (require('rwlock'))(),
    async = require('async'),
    request = require('request'),
    events = new (require('events').EventEmitter)(),
    fileHandler = require('./lib/public/file-handler.js'),
    generalTools = require('./lib/public/general-tools.js'),
    emailModule = require('./lib/public/email-module.js');

var email;

//電視鏡面顯示各縣市鄉鎮市區格式轉換 json 檔
var tvAreaFormat = require('./lib/resource/tv-area-format.json');

//設定檔
var appConfig = require('./app-config.js');

//目前支援的天氣速報類型文字檔範本，目前僅支援 Thunderstorm 雷雨速報
var weatherEventsTxtTemplate = {
    thunderstorm: ['time ## %s時%s分至%s時%s分\r\narea ## %s\r\n\r\n', 'area ## %s\r\n']
};

//電子郵件資訊範本
var mailInfoModel = {
    identifiers: '',
    weatherEvent: '',
    client_info: '',
    subject: '天氣速報通知',
    message: ''
};

//監聽事件 - 寫入 log 與修改檔案副檔名，並判斷是否需要寄送郵件通知
events.on('writeLogWithRenameAndSendMail', function (data) {
    if (data) {
        writeEventLog(data.weatherEvent, data.message, data.identifiers, function () {

            //是否需要修改檔案名稱
            if (data.isRename) {
                renameCapExt(data.weatherEvent, data.message, data.renameFiles);
            }

            //是否需要寄送郵件通知
            if (data.isSendEmail) {
                var mailInfoObj = generalTools.cloneJsonObject(mailInfoModel);
                mailInfoObj.weatherEvent = data.weatherEvent;
                mailInfoObj.identifiers = data.identifiers;
                mailInfoObj.message = data.message;
                events.emit('sendEmail', mailInfoObj);
            }
        });
    }
});

//監聽事件 - 發送電子郵件事件
events.on('sendEmail', function (mailInfoObj) {

    //判斷是否需要初始化 email 模組
    if (!email) {
        email = new emailModule(
            appConfig.email_info.smtp,
            appConfig.email_info.port,
            appConfig.email_info.secure,
            appConfig.email_info.user,
            appConfig.email_info.pass
        );
    }

    //天氣類型中文說明
    var weatherEventDesc = (function () {
        switch (mailInfoObj.weatherEvent) {
            case 'thunderstorm':
                return '雷雨速報';
            default:
                return '';
        }
    })();

    var mailContent = util.format('主機： %s\r\n類型： %s\r\n識別： %s\r\n訊息： %s\r\n時間： %s',
        generalTools.getHostIps('ipv4').ipv4[0],
        weatherEventDesc,
        mailInfoObj.identifiers,
        mailInfoObj.message,
        moment().format('YYYY-MM-DD HH:mm:ss')
    );

    lock.writeLock(function (release) {
        email.sendMail(
            appConfig.email_info.sender,
            appConfig.email_info.receivers,
            mailInfoObj.subject,
            mailContent,
            null,
            function (err, info) {
                if (err) {      //寄發郵件發生錯誤，寫入 log
                    events.emit('writeLogWithRenameAndSendMail', {
                        isRename: false,
                        weatherEvent: null,
                        message: util.format('監聽天氣速報程式在寄送電子郵件通知時，發生錯誤 (error： %s)', err),
                        identifiers: null,
                        renameFiles: null,
                        isSendEmail: false
                    });
                }

                release();
            }
        );
    });
});

//啟動天氣速報目錄監聽服務
var watcher;
var tempStoreCaps = [];
var timeout;

//建立雷雨速報目錄監聽器
watcher = chokidar.watch(appConfig.weather_source_path, {
    ignored: /^.*\.(?!cap$)[^.]+$/,     //忽略非 cap 副檔名規則
    persistent: true,       //重複執行監視
    //usePolling: true,
    //interval: appConfig.watch_interval
});

//監聽天氣速報目錄準備完成時，檢查歷史紀錄目錄結構是否存在，若不存在則建立(目前僅有雷雨速報)
watcher.on('ready', function () {
    fileHandler.createFileIfNotExists(
        appConfig.history_info_json.dir,
        appConfig.history_info_json.history_list[0].file_name,
        appConfig.history_info_json.history_list[0].content_struct,
        function (err) {


            //若建立歷史紀錄目錄結構失敗則不進行監聽動作
            if (err) {
                events.emit('writeLogWithRenameAndSendMail', {
                    isRename: false,
                    weatherEvent: null,
                    message: util.format('初始化雷雨速報歷史紀錄結構發生錯誤，程式即將中止服務 (error： %s)', err),
                    identifiers: appConfig.history_info_json.dir + appConfig.history_info_json.history_list[0].file_name,
                    renameFiles: null,
                    isSendEmail: true
                });

                watcher.close();
            }
        }
    );
});

//對天氣速報目錄監聽發生錯誤
watcher.on('error', function (err) {
    events.emit('writeLogWithRenameAndSendMail', {
        isRename: false,
        weatherEvent: null,
        message: util.format('監聽天氣速報程式發生錯誤，程式即將中止服務 (error： %s)', err),
        identifiers: appConfig.weather_source_path,
        renameFiles: null,
        isSendEmail: true
    });

    watcher.close();
});

//天氣速報類型 xpath 語法
var weatherEventXpath = '//*[local-name(.)="alert"]/*[local-name(.)="info"]/*[local-name(.)="eventCode"]/*[local-name(.)="value"]';

//對天氣速報目錄監聽新增檔案事件
watcher.on('add', function (capAbsPath) {

    events.emit('writeLogWithRenameAndSendMail', {
        isRename: false,
        weatherEvent: null,
        message: '已接收到新的 CAP 資料傳入',
        identifiers: capAbsPath,
        renameFiles: null,
        isSendEmail: false
    });

    //增加延遲，以避免讀取 cap 檔內容時發生 busy lock 問題
    setTimeout(function () {
        fs.readFile(capAbsPath, 'utf8', function (err, content) {
            if (!err) {     //成功讀取到 cap 檔案
                var xDoc = new xmlParse().parseFromString(content);
                if (xDoc) {

                    ////天氣速報唯一編號
                    //var identityNode = xpath.select('//*[local-name(.)="alert"]/*[local-name(.)="identifier"]', xDoc)[0];
                    //if (identityNode) {
                    //    var identity = identityNode.firstChild.data;

                    //    //天氣速報類型
                    //    var weatherEventNode = xpath.select('//*[local-name(.)="alert"]/*[local-name(.)="info"]/*[local-name(.)="eventCode"]/*[local-name(.)="value"]', xDoc)[0];
                    //    if (weatherEventNode) {
                    //        var weatherEvent = weatherEventNode.firstChild.data.toLowerCase();

                    //        //檢查目前是否有支援此天氣速報類型
                    //        if (weatherEventsTxtTemplate.hasOwnProperty(weatherEvent)) {
                    //            dataProcess(weatherEvent, xDoc, capAbsPath);
                    //        }
                    //    }
                    //}

                    //天氣速報類型
                    var weatherEventNode = xpath.select(weatherEventXpath, xDoc)[0];
                    if (weatherEventNode && weatherEventNode.firstChild) {
                        var weatherEvent = weatherEventNode.firstChild.data.toLowerCase();

                        //檢查天氣速報類型是否為雷雨速報(目前僅支援此)
                        if (weatherEvent === 'thunderstorm') {
                            tempStoreCaps.push({
                                weatherEvent: weatherEvent,     //天氣速報類型
                                description: '',        //天氣速報描述
                                instruction: '',        //天氣速報警示語
                                counties: '',       //影響縣市
                                townships: '',      //影響鄉鎮市區
                                isPws: 0,       //是否發布 pws 警報
                                onset: null,        //開始發生時間
                                expires: null,      //結束發生時間
                                xDoc: xDoc,     //cap xml document
                                capAbsPath: capAbsPath,     //cap 絕對路徑
                                identifier: '',      //cap 唯一識別碼
                                test_mode: true     //cap 是否為測試版本
                            });

                            //每次接收到新的 cap 資料便重新計時延遲處理，以確保延遲時間內的分批接收的資料能夠一起處理(延遲時間依據設定檔決定)
                            clearTimeout(timeout);
                            timeout = setTimeout(function () {
                                if (tempStoreCaps.length > 0) {

                                    //複製暫存 cap 陣列後清空，準備接收下一次的資料
                                    var processCaps = tempStoreCaps.slice();
                                    tempStoreCaps = [];

                                    //cap 歷史記錄 json 檔案位置
                                    var processedFilePath = util.format('%s\\%s',
                                        appConfig.history_info_json.dir,
                                        appConfig.history_info_json.history_list[0].file_name
                                    );

                                    //讀取歷史記錄 json 檔案
                                    fileHandler.readFileContent(processedFilePath, function (err, content) {
                                        if (!err) {
                                            dataProcess(weatherEvent, processCaps, JSON.parse(content));
                                        } else {        //讀取雷雨速報歷史紀錄檔失敗
                                            events.emit('writeLogWithRenameAndSendMail', {
                                                isRename: true,
                                                weatherEvent: weatherEvent,
                                                message: util.format('讀取雷雨速報歷史記錄檔發生錯誤 (error： %s)', err),
                                                identifiers: processedFilePath,
                                                renameFiles: processCaps,
                                                isSendEmail: true
                                            });
                                        }
                                    });
                                }
                            }, appConfig.delay_millisecond);

                        } else {
                            events.emit('writeLogWithRenameAndSendMail', {
                                isRename: true,
                                weatherEvent: null,
                                message: util.format('發現無法支援的天氣速報類型 (weatherEvent： %s)', weatherEvent),
                                identifiers: capAbsPath,
                                renameFiles: [capAbsPath],
                                isSendEmail: true
                            });
                        }

                    } else {
                        events.emit('writeLogWithRenameAndSendMail', {
                            isRename: true,
                            weatherEvent: null,
                            message: util.format('解析天氣速報類型節點發生錯誤 (xpath： %s)', weatherEventXpath),
                            identifiers: capAbsPath,
                            renameFiles: [capAbsPath],
                            isSendEmail: true
                        });
                    }

                } else {
                    events.emit('writeLogWithRenameAndSendMail', {
                        isRename: true,
                        weatherEvent: null,
                        message: '轉換 CAP 檔案為 XML 物件發生錯誤',
                        identifiers: capAbsPath,
                        renameFiles: [capAbsPath],
                        isSendEmail: true
                    });
                }

            } else {
                events.emit('writeLogWithRenameAndSendMail', {
                    isRename: true,
                    weatherEvent: null,
                    message: util.format('讀取 CAP 檔案內容發生錯誤 (error： %s)', err),
                    identifiers: capAbsPath,
                    renameFiles: [capAbsPath],
                    isSendEmail: true
                });
            }
        });
    }, 200);
});

/**
 * 解析天氣速報 cap xml 資料並進行歷史紀錄檢查
 * 
 * weatherEvent： 天氣速報事件類型
 * caps： cap 資料陣列
 * historyJson： 天氣速報歷史資料 json 物件
 */
function dataProcess(weatherEvent, caps, historyJson) {

    //判斷天氣速報類型決定如何處理
    switch (weatherEvent) {
        case 'thunderstorm'://雷雨速報
            var isContinue = true;
            var formalCaps = [];
            var testCaps = [];

            for (var i = 0; i < caps.length; i++) {
                if (!isContinue) { break; }

                var cap = caps[i];

                //檢查 cap 檔是否為測試模式
                try {
                    var status = (xpath.select('//*[local-name(.)="alert"]/*[local-name(.)="status"]', cap.xDoc)[0]).firstChild.data;
                    var msgType = (xpath.select('//*[local-name(.)="alert"]/*[local-name(.)="msgType"]', cap.xDoc)[0]).firstChild.data;

                    cap.test_mode = (status !== appConfig.weather_type.thunderstorm.formal_status
                        || msgType !== appConfig.weather_type.thunderstorm.formal_msgType);

                } catch (e) { };

                //檢查傳入的 cap 唯一識別碼是否已存在歷史紀錄內
                //resultCode：
                //1： 傳入的 cap 檔名尚未處理過(正式版本)
                //2： 傳入的 cap 檔名尚未處理過(測試版本)
                //-2： 傳入的 cap 檔名已處理過
                //-3： 讀取雷雨速報歷史失敗
                checkCapIsProcessed(weatherEvent, cap, historyJson, function (resultCode, currentCap) {
                    if (resultCode >= 1) {

                        //info 元素
                        var xpathSyntax = '//*[local-name(.)="alert"]/*[local-name(.)="info"]';
                        var infoNode = xpath.select(xpathSyntax, currentCap.xDoc)[0];
                        if (infoNode) {

                            try {
                                //雷雨速報開始時間
                                xpathSyntax = '//*[local-name(.)="onset"]';
                                currentCap.onset = new Date((xpath.select(xpathSyntax, infoNode)[0]).firstChild.data);

                                //雷雨速報結束時間
                                xpathSyntax = '//*[local-name(.)="expires"]';
                                currentCap.expires = new Date((xpath.select(xpathSyntax, infoNode)[0]).firstChild.data);

                                ////雷雨速報描述
                                //xpathSyntax = '//*[local-name(.)="description"]';
                                //currentCap.description = (xpath.select(xpathSyntax, infoNode)[0]).firstChild.data;

                                ////雷雨速報警語
                                //xpathSyntax = '//*[local-name(.)="instruction"]';
                                //currentCap.instruction = (xpath.select(xpathSyntax, infoNode)[0]).firstChild.data;

                                //雷雨影響縣市
                                xpathSyntax = '//*[local-name(.)="parameter"]/*[local-name(.)="valueName" and .="counties"]/following-sibling::*[local-name(.)="value"]';
                                currentCap.counties = (xpath.select(xpathSyntax, infoNode)[0]).firstChild.data;

                                //雷雨影響鄉鎮市區
                                xpathSyntax = '//*[local-name(.)="parameter"]/*[local-name(.)="valueName" and .="townships"]/following-sibling::*[local-name(.)="value"]';
                                currentCap.townships = (xpath.select(xpathSyntax, infoNode)[0]).firstChild.data;

                                ////是否有發佈災防告警(80毫米以上)
                                //xpathSyntax = '//*[local-name(.)="parameter"]/*[local-name(.)="valueName" and .="CHANNEL"]/following-sibling::*[local-name(.)="value"]';
                                //var pwsNode = xpath.select(xpathSyntax, infoNode)[0];
                                //currentCap.isPws = ((pwsNode.firstChild.data == '13,13911') ? 1 : 0);

                                //依據檢查歷史紀錄函式回傳值決定當前 cap 為正式(1)或測試(2)
                                ((resultCode === 1) ? formalCaps.push(currentCap) : testCaps.push(currentCap));

                            } catch (e) {
                                isContinue = false;
                                events.emit('writeLogWithRenameAndSendMail', {
                                    isRename: true,
                                    weatherEvent: weatherEvent,
                                    message: util.format('解析雷雨速報節點內容發生錯誤 (xpath： %s)', xpathSyntax),
                                    identifiers: appendCapAbsPaths(caps),
                                    renameFiles: caps,
                                    isSendEmail: true
                                });
                            };

                        } else {
                            isContinue = false;
                            events.emit('writeLogWithRenameAndSendMail', {
                                isRename: true,
                                weatherEvent: weatherEvent,
                                message: util.format('解析雷雨速報節點內容發生錯誤 (xpath： %s)', xpathSyntax),
                                identifiers: appendCapAbsPaths(caps),
                                renameFiles: caps,
                                isSendEmail: true
                            });
                        }

                    } else {
                        isContinue = false;
                        var logMessage = (function () {
                            if (resultCode === -1) {
                                return util.format('取得雷雨速報唯一識別碼時發生錯誤 (error： %s)', resultCode);
                            } else if (resultCode === -2) {
                                return util.format('檢查雷雨速報唯一識別碼時發現重複 (identifier： %s)', currentCap.identifier);
                            }
                        })();

                        events.emit('writeLogWithRenameAndSendMail', {
                            isRename: true,
                            weatherEvent: weatherEvent,
                            message: logMessage,
                            identifiers: appendCapAbsPaths(caps),
                            renameFiles: caps,
                            isSendEmail: true
                        });
                    }
                });
            }

            //判斷若正式版本與測試版本資料陣列長度加總後與一開始讀入的 cap 資料陣列長度相同才建立工程部 txt 檔案
            if ((formalCaps.length + testCaps.length) === caps.length) {
                processCapsToTxt(weatherEvent, formalCaps, testCaps, historyJson);
            }

            break;
    }
};

/**
 * 處理 cap 資料轉換為文字檔案
 * 
 * weatherEvent： 天氣速報事件類型
 * formalCaps： 正式版本 cap 資料
 * testCaps： 測試版本 cap 資料
 * historyJson： 歷史紀錄 json 物件
 */
function processCapsToTxt(weatherEvent, formalCaps, testCaps, historyJson) {
    switch (weatherEvent) {
        case 'thunderstorm'://雷雨速報

            //產生正式版本指定的文字檔內容
            if (formalCaps.length > 0) {

                //callback(錯誤訊息, 文字檔內容)
                createTxtFormat(weatherEvent, false, formalCaps, function (err, tsTxtContentJson) {
                    var identifiers = appendIdentifiers(formalCaps);

                    if (!err) {

                        //利用 async 模組的 parallel 方法進行平行同時處理多個函式
                        async.parallel({
                            store_processed_cap: function (callback) {      //正式發送模式下才將已處理完成的 cap 資訊寫入歷史紀錄
                                storeProcessedCapInfo(weatherEvent, formalCaps, historyJson, function (err) {
                                    callback(null, err, null);      //callback 若有第三個傳入參數開始，會以陣列方式呈現，若沒有則以單值呈現
                                });
                            },
                            push_line: function (callback) {        //推播雷雨速報至 Line 平台
                                pushLineMessage(weatherEvent, formalCaps, function (err, res) {     //callback(錯誤訊息, http request 回應物件)
                                    callback(null, err, res);       //callback 若有第三個傳入參數開始，會以陣列方式呈現，若沒有則以單值呈現
                                });
                            }
                        }, function (err, result) {     //callback 處理
                            var logMessage;
                            var isSendEmail;

                            //依據 async.parallel 所自定義的 key 做各別後續寫入 log 與寄送電子郵件處理
                            Object.keys(result).forEach(function (key, idx) {
                                var errMessage = result[key][0];        //取得每一個平行處理傳入 callback 第二個參數(是否有錯誤訊息，若無為 null)

                                switch (key) {
                                    case 'store_processed_cap':     //cap 資訊寫入歷史紀錄回應結果處理
                                        if (errMessage) {
                                            isSendEmail = true;
                                            logMessage = util.format('建立天氣速報資料文字檔成功但寫入歷史記錄失敗 (error： %s)', errMessage);
                                        } else {
                                            isSendEmail = appConfig.processed_successful_send_mail;
                                            logMessage = '建立天氣速報資料文字檔與寫入歷史記錄成功';
                                        }

                                        events.emit('writeLogWithRenameAndSendMail', {
                                            isRename: false,
                                            weatherEvent: weatherEvent,
                                            message: logMessage,
                                            identifiers: identifiers,
                                            renameFiles: null,
                                            isSendEmail: isSendEmail
                                        });

                                        break;
                                    case 'push_line':       //推播雷雨速報至 Line 平台回應結果處理
                                        if (errMessage) {
                                            isSendEmail = true;
                                            logMessage = util.format('推播天氣速報資料至 Line 平台發生無法預期的錯誤 (error： %s)', errMessage);
                                        } else {
                                            var responseBodyJson = JSON.parse(result[key][1].body);

                                            //推播天氣速報訊息至 Line 平台發生處理程序錯誤
                                            if (responseBodyJson.result_code != 1) {
                                                isSendEmail = true;
                                                logMessage = util.format('推播天氣速報資料至 Line 平台發生無法預期的錯誤 (result_code： %s，result_message： %s)',
                                                    responseBodyJson.result_code, responseBodyJson.result_message);
                                            } else {
                                                isSendEmail = appConfig.processed_successful_send_mail;
                                                logMessage = '推播天氣速報資料至 Line 平台發送成功';
                                            }
                                        }

                                        events.emit('writeLogWithRenameAndSendMail', {
                                            isRename: false,
                                            weatherEvent: weatherEvent,
                                            message: logMessage,
                                            identifiers: identifiers,
                                            renameFiles: null,
                                            isSendEmail: isSendEmail
                                        });

                                        break;
                                }
                            });
                        });

                    } else {
                        events.emit('writeLogWithRenameAndSendMail', {
                            isRename: false,
                            weatherEvent: weatherEvent,
                            message: util.format('建立雷雨速報文字檔發生錯誤 (error： %s)', err),
                            identifiers: identifiers,
                            renameFiles: null,
                            isSendEmail: true
                        });
                    }

                    //利用文字檔產生結果判斷要修改的檔案副檔名，以避開 cap 檔案被 watch 的問題
                    renameCapExt(weatherEvent, err, formalCaps);
                });
            }

            //產生測試版本指定的文字檔內容
            if (testCaps.length > 0) {
                createTxtFormat(weatherEvent, true, testCaps, function (err) {
                    var identifiers = appendIdentifiers(testCaps);

                    if (!err) {
                        events.emit('writeLogWithRenameAndSendMail', {
                            isRename: false,
                            weatherEvent: weatherEvent,
                            message: '(測試資料)建立雷雨速報資料文字檔成功',
                            identifiers: identifiers,
                            renameFiles: null,
                            isSendEmail: appConfig.processed_successful_send_mail
                        });
                    } else {
                        events.emit('writeLogWithRenameAndSendMail', {
                            isRename: false,
                            weatherEvent: weatherEvent,
                            message: util.format('(測試資料)建立雷雨速報文字檔發生錯誤 (error： %s)', err),
                            identifiers: identifiers,
                            renameFiles: null,
                            isSendEmail: true
                        });
                    }

                    //利用文字檔產生結果判斷要修改的檔案副檔名，以避開 cap 檔案被 watch 的問題
                    renameCapExt(weatherEvent, err, testCaps);
                });
            }

            break;
    }
};

/**
 * 修改 cap 檔案副檔名
 * 
 * weatherEvent： 天氣速報事件類型
 * hasErr： 是否有錯誤訊息(若有字串則為有)
 * caps： cap 資料陣列
 */
function renameCapExt(weatherEvent, hasErr, caps) {
    var convertExt = ((!hasErr) ? appConfig.convert_success_ext : appConfig.convert_failure_ext);
    switch (weatherEvent) {
        case 'thunderstorm':
            for (var i = 0; i < caps.length; i++) {
                fs.rename(caps[i].capAbsPath, caps[i].capAbsPath + '.' + convertExt);
            };
            break;
        default://路徑字串陣列
            for (var i = 0; i < caps.length; i++) {
                fs.rename(caps[i], caps[i] + '.' + convertExt);
            };
    }
};

/**
 * 將傳入的 cap 資料陣列內唯一識別碼字串合併
 * 
 * caps： cap 資料陣列
 */
function appendIdentifiers(caps) {
    var identiifers = '';
    for (var i = 0; i < caps.length; i++) {
        identiifers += caps[i].identifier + ',\r\n';
    };

    return identiifers;
};

/**
 * 將傳入的 cap 資料陣列內檔案路徑字串合併
 */
function appendCapAbsPaths(caps) {
    var capAbsPaths = '';
    for (var i = 0; i < caps.length; i++) {
        capAbsPaths += caps[i].capAbsPath + ',\r\n';
    };

    return capAbsPaths;
};

/**
 * 檢查傳入的 cap 檔是否已存在歷史紀錄內
 * 
 * weatherEvent： 天氣速報事件類型
 * currentCap： 當前處理的 cap 資料物件
 * historyJson： 天氣速報歷史紀錄 json 物件
 * callback： 回應函式
 */
function checkCapIsProcessed(weatherEvent, currentCap, historyJson, callback) {
    switch (weatherEvent) {
        case 'thunderstorm'://雷雨速報(利用雷雨速報唯一識別碼來判斷資料是否於之前處理過)
            var identifierNode = xpath.select('//*[local-name(.)="alert"]/*[local-name(.)="identifier"]', currentCap.xDoc)[0];
            if (identifierNode && identifierNode.firstChild) {
                currentCap.identifier = identifierNode.firstChild.data;

                //只有在正式模式下才進行歷史紀錄檢查
                if (!currentCap.test_mode) {

                    //傳入的 cap 檔名是否有存在於歷史紀錄中
                    if (historyJson.processed_caps.indexOf(currentCap.identifier) === -1) {
                        callback(1, currentCap);       //傳入的 cap 內容為正式版本
                    } else {        //雷雨速報唯一識別碼已在歷史紀錄檔內存在
                        callback(-2, currentCap);
                    }
                } else {
                    callback(2, currentCap);        //傳入的 cap 內容為測試版本
                }

            } else {        //遺失雷雨速報唯一識別碼
                callback(-1);
            }

            break;
    }
};

/**
 * 將已完成的天氣速報資訊存入歷史紀錄
 * 
 * weatherEvent： 天氣速報事件類型
 * caps： cap 資料物件陣列
 * historyJson： 歷史紀錄 json 物件
 * callback： 回應函式
 */
function storeProcessedCapInfo(weatherEvent, caps, historyJson, callback) {
    switch (weatherEvent) {
        case 'thunderstorm'://雷雨速報

            for (var i = 0; i < caps.length; i++) {
                var cap = caps[i];

                //判斷歷史紀錄內存放雷雨速報唯一識別碼數量是否已達存放上限，若有則移除第一筆
                if (historyJson.processed_caps.length === appConfig.store_processed_count) {
                    historyJson.processed_caps.shift();
                }

                //將最新的地震速報加入至已處理過的歷史紀錄最後一筆
                historyJson.processed_caps.push(cap.identifier);
            };

            fileHandler.createOrWriteFile(
                appConfig.history_info_json.dir,
                appConfig.history_info_json.history_list[0].file_name,
                JSON.stringify(historyJson),
                function (err) {
                    callback(err);
                }
            );

            break;
    }
};

/**
 * 產生指定的文字檔內容格式
 * 
 * weatherEvent： 天氣速報事件類型
 * testMode： 是否為測試模式
 * caps： 文字檔內容資料物件陣列
 * callback： 回應函式
 */
function createTxtFormat(weatherEvent, testMode, caps, callback) {

    //判斷天氣速報事件類型決定要產生的文字檔格式
    switch (weatherEvent) {
        case 'thunderstorm'://雷雨速報

            //要傳回給呼叫端的雷雨速報兩份文字檔內容
            var tsTxtContentJson = {
                ts_counties: null,
                ts_townships: null
            }

            //雷雨速報文字檔範本(X2)陣列
            var thunderstormTemplate = weatherEventsTxtTemplate[weatherEvent];
            var tsCountiesContent;

            try {
                //產生第一份雷雨速報影響縣市內容(若時間為0時0分，須補齊為兩位數)
                tsCountiesContent = util.format(thunderstormTemplate[0],
                    padLeft(caps[caps.length - 1].onset.getHours(), 2, '0'),       //開始時(固定取最後一筆)
                    padLeft(caps[caps.length - 1].onset.getMinutes(), 2, '0'),     //開始分(固定取最後一筆)
                    padLeft(caps[caps.length - 1].expires.getHours(), 2, '0'),     //結束時(固定取最後一筆)
                    padLeft(caps[caps.length - 1].expires.getMinutes(), 2, '0'),        //結束分(固定取最後一筆)
                    (function () {      //將傳入的影響縣市加總後轉換為電視鏡面縣市格式
                        var totalCounties = '';
                        for (var i = 0; i < caps.length; i++) {
                            var counties = caps[i].counties.split(',');     //每個 cap 檔內的影響縣市陣列
                            for (var j = 0; j < counties.length; j++) {
                                var county = counties[j];       //每個 cap 檔內的影響縣市陣列內的單一縣市
                                for (var k = 0; k < tvAreaFormat.cities.length; k++) {
                                    var cityObj = tvAreaFormat.cities[k];       //每個電視鏡面縣市轉換物件

                                    //判斷要加入的影響縣市名稱是否已存在變數內，若有則不加入
                                    if (county === cityObj.origin && totalCounties.indexOf(cityObj.format) === -1) {
                                        totalCounties += cityObj.format + ' ';
                                    }
                                }
                            }
                        }
                        return totalCounties.trim();
                    })());

            } catch (ex) {
                callback(ex);
                return;
            };

            //產生第一份雷雨速報影響縣市文字檔
            //第一份雷雨速報影響縣市文字檔副檔名暫時修改，再依據第二份雷雨速報影響區域文字檔建立結果決定要還原或刪除
            var tempExtName = '.temp';
            var tempDescTxtFileName = ((!testMode) ?
                appConfig.weather_type.thunderstorm.desc_txt : appConfig.weather_type.thunderstorm.desc_txt_test) + tempExtName;

            lock.writeLock(function (release) {
                fileHandler.createOrWriteFile(
                    appConfig.weather_type.thunderstorm.txt_path,
                    tempDescTxtFileName,
                    tsCountiesContent,
                    function (writeDescErr) {
                        if (!writeDescErr) {

                            //要傳回給呼叫端的雷雨速報第一份文字檔內容
                            tsTxtContentJson.ts_counties = tsCountiesContent;

                            //產生第二份雷雨速報警戒區域內容
                            var tsTownshipsContent = '';
                            try {
                                for (var i = 0; i < caps.length; i++) {

                                    var cap = caps[i];
                                    var townships = cap.townships.split(' ');        //縣市鄉鎮市區陣列

                                    //將傳入的第二組影響"縣市"資料轉換為電視鏡面格式(如：臺北市大安區 -> 臺北大安區)
                                    for (var j in townships) {
                                        if (townships[j].length > 0) {
                                            var county = townships[j].substring(0, 3);      //轉換縣市格式只對前三個字元進行替換，以免發生錯誤
                                            for (var k in tvAreaFormat.cities) {
                                                if (county === tvAreaFormat.cities[k].origin) {
                                                    townships[j] = townships[j].replace(county, tvAreaFormat.cities[k].format);
                                                }
                                            }
                                        }
                                    }

                                    //將傳入的第二組影響"鄉鎮市區"資料轉換為電視鏡面格式(如：臺北大安區 -> 臺北大安)
                                    for (var j in townships) {
                                        if (townships[j].length > 0) {
                                            var township = townships[j].substring(2);      //轉換鄉鎮市區格式只對縣市以外的字元進行替換，以免發生錯誤
                                            for (var k in tvAreaFormat.townships) {
                                                if (township === tvAreaFormat.townships[k].origin) {
                                                    townships[j] = townships[j].replace(township, tvAreaFormat.townships[k].format);
                                                }
                                            }
                                        }
                                    }

                                    //產生文字檔內容
                                    for (var j in townships) {
                                        var township = townships[j];

                                        //判斷要加入的影響鄉鎮市區名稱是否已存在變數內，若有則不加入
                                        if (township.length > 0 && tsTownshipsContent.indexOf(township) === -1) {
                                            tsTownshipsContent += util.format(thunderstormTemplate[1], township);
                                        }
                                    }
                                };

                                tsTownshipsContent += '\r\n';     //資料最末端加入空行
                            } catch (ex) {
                                callback(ex);
                                release();
                                return;
                            };

                            //產生第二份雷雨速報影響區域文字檔
                            fileHandler.createOrWriteFile(
                                appConfig.weather_type.thunderstorm.txt_path,
                                ((!testMode) ? appConfig.weather_type.thunderstorm.area_txt : appConfig.weather_type.thunderstorm.area_txt_test),
                                tsTownshipsContent,
                                function (writeAreaErr) {

                                    //若第二份雷雨速報影響區域文字檔建立成功，便將第一份雷雨速報描述文字檔副檔名還原
                                    //若第二份雷雨速報影響區域文字檔建立失敗，便將第一份雷雨速報描述文字檔刪除
                                    var tempDescTxtFilePath = appConfig.weather_type.thunderstorm.txt_path + tempDescTxtFileName;
                                    if (!writeAreaErr) {

                                        //要傳回給呼叫端的雷雨速報第二份文字檔內容
                                        tsTxtContentJson.ts_townships = tsTownshipsContent;

                                        fs.rename(tempDescTxtFilePath, tempDescTxtFilePath.replace(tempExtName, ''));
                                    } else {
                                        fs.unlink(tempDescTxtFilePath);
                                    }

                                    callback(writeAreaErr, tsTxtContentJson);
                                    release();
                                }
                            );
                        } else {
                            callback(writeDescErr);
                            release();
                        }
                    }
                );
            });

            break;
    }
};

/**
 * 發送天氣速報即時訊息至 Line 推播 API
 * weatherEvent： 天氣速報類型
 * contents： 要推播的天氣速報內容(依據天氣速報類型傳入的內容格式不一定會是固定的，好處理就可以)
 * callback： 回應函式
 */
function pushLineMessage(weatherEvent, contents, callback) {
    if (weatherEvent && contents) {
        var weatherEventCode;
        var pushMessage;

        try {
            //依據天氣速報類型決定要推播的文字訊息格式
            switch (weatherEvent) {
                case 'thunderstorm':        //雷雨速報
                    var pushOnsetDT;
                    var pushExpiresDT;
                    var pushCounties = '';
                    var pushTownships = '';
                    weatherEventCode = 2;       //推播天氣類型代碼(0：全部、1：地震速報、2：雷雨速報)

                    contents.forEach(function (content, idx) {

                        //取得雷雨速報開始結束時間，固定取最後一筆資料
                        if (idx === contents.length - 1) {
                            pushOnsetDT = moment(content.onset).format('YYYY-MM-DD HH:mm');
                            pushExpiresDT = moment(content.expires).format('YYYY-MM-DD HH:mm');
                        }

                        //雷雨速報影響縣市
                        content.counties.split(',').forEach(function (county, idx) {
                            if (pushCounties.indexOf(county) === -1) {
                                pushCounties += (county + ' ');
                            }
                        });

                        //雷雨速報影響鄉鎮市區
                        content.townships.split(' ').forEach(function (township, idx) {
                            if (pushTownships.indexOf(township) === -1) {
                                pushTownships += (township + ' ');
                            }
                        });
                    });

                    pushMessage = util.format('【%s】\r\n\r\n%s\r\n至\r\n%s\r\n\r\n%s\r\n\r\n%s',
                        '雷雨速報',
                        pushOnsetDT.trim(),     //雷雨速報開始時間
                        pushExpiresDT.trim(),     //雷雨速報結束時間
                        pushCounties.trim(),     //雷雨影響縣市
                        pushTownships.trim()     //雷雨影響鄉鎮市區
                    );

                    break;
            }

            request(
                {
                    method: 'post',
                    url: appConfig.push_line_message_url,
                    form: {
                        weather_event_code: weatherEventCode,
                        push_message: pushMessage
                    }
                }, function (err, res, body) {
                    if (callback) {
                        callback(err, res);
                    }
                }
            );
        } catch (ex) {
            if (callback) {
                callback(ex);
            }
        }
    }
};

/**
 * 事件紀錄 log 檔處理
 * 
 * weatherEvent： 天氣速報事件類型
 * logMessage： log 訊息
 * identifiers： 檔案識別資料(identifier or file path)
 * callbcak： 回應函式
 */
function writeEventLog(weatherEvent, logMessage, identifiers, callbcak) {

    //依據天氣速報事件類型建立事件 log 目錄，存放在專案目錄下
    var logPath = (function () {
        var path = __dirname + '\\';
        switch (weatherEvent) {
            case 'thunderstorm'://雷雨速報
                path += appConfig.weather_type.thunderstorm.log_folder;
                break;
            default://若無天氣速報事件類型，則存放於系統紀錄資料夾
                path += appConfig.system_log_folder;
        }

        path += '\\';
        return path;
    })();

    //log 檔案名稱開頭加上目前日期
    var logFileName = moment().format('YYYY-MM-DD') + '_' + appConfig.log_file_name;

    //檔案內容開頭加上目前時間
    logMessage = moment().format('HH:mm:ss') + ' - ' + logMessage + ' - ' + identifiers + '\r\n\r\n';

    //產生 log 紀錄檔案
    //因可能會有多個程序執行此函式，故須使用寫檔鎖定，一次只能有一個程序寫檔
    lock.writeLock(function (release) {
        fileHandler.createOrAppendFile(logPath, logFileName, logMessage, function (err) {
            console.log(logMessage);
            if (callbcak) { callbcak(err); }
            release();
        });
    });
};