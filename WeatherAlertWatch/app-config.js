module.exports = {
    weather_source_path: 'D:\\thunderstorm_cap\\',      //天氣速報資料來源目錄
    system_log_folder: 'system_log',        //系統事件紀錄資料夾
    log_file_name: 'log.txt',       //天氣速報事件紀錄檔名
    store_processed_count: 10,       //存放天氣速報已處理過的 cap 檔名數量
    delay_millisecond: 10000,      //取得新的 cap 檔案後延遲處理毫秒
    convert_success_ext: 'success',        //處理天氣速報文字檔成功要轉換的副檔名
    convert_failure_ext: 'failure',        //處理天氣速報文字檔失敗要轉換的副檔名
    //convert_repeat_ext: 'repeat',        //處理天氣速報文字檔發現資料重複要轉換的副檔名
    processed_successful_send_mail: true,       //程序若處理成功是否寄發電子郵件通知
    push_line_message_url: 'push_line_message_url',

    //天氣類型檔案結構資訊
    weather_type: {
        thunderstorm: {
            txt_path: 'D:\\thunderstorm_txt\\',        //雷雨速報文字檔存放目錄
            desc_txt: 'alarm_rain.txt',       //雷雨速報描述資料文字檔名稱
            area_txt: 'alarm_rain_smal.txt',       //雷雨速報地區資料文字檔名稱
            desc_txt_test: 'test_alarm_rain.txt',       //雷雨速報描述資料文字檔名稱(測試版本)
            area_txt_test: 'test_alarm_rain_smal.txt',       //雷雨速報地區資料文字檔名稱(測試版本)
            log_folder: 'thunderstorm_log',       //雷雨速報事件紀錄資料夾
            //log_folder_test: 'thunderstorm_log_test',       //雷雨速報事件紀錄資料夾(測試版本)
            formal_status: 'Actual',      //雷雨速報正式模式 CAP檔 status 元素值
            formal_msgType: 'Alert'      //雷雨速報正式模式 CAP檔 msgType 元素值
        }
    },

    //歷史紀錄檔案相關資訊(目前僅有雷雨速報)
    history_info_json: {
        dir: require('util').format('%s\\%s\\', __dirname, 'weather_history'),     //存放路徑
        history_list: [     //各項歷史紀錄列表
            {
                file_name: 'thunderstorm_history.json',     //檔名
                content_struct: '{"processed_caps": []}'      //內容結構
            }
        ]
    },

    //寄發電子郵件主機資訊
    email_info: {
        user: 'user',
        pass: 'pass',
        secure: false,
        smtp: 'smtp',
        port: 25,
        sender: '天氣速報 <sender@mail>',
        receivers: ['receivers']
    }
}