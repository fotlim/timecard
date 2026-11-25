package com.timecard.mobile;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * 挂卡时间轴 · Android 入口
 *
 * 硬件返回键处理：不引入 @capacitor/app，直接问 Web 端「这次返回你处理了吗」。
 * 页面里对应的钩子是 window.__tcBack()：有抽屉先关抽屉、有筛选先关筛选、
 * 都没有返回 'false'，这时才交给系统走默认退出。
 */
public class MainActivity extends BridgeActivity {

    private static final String BACK_SCRIPT =
        "(function(){try{return (window.__tcBack && window.__tcBack()) || 'false'}catch(e){return 'false'}})()";

    @Override
    public void onBackPressed() {
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) {
            super.onBackPressed();
            return;
        }
        bridge.getWebView().evaluateJavascript(BACK_SCRIPT, value -> {
            // evaluateJavascript 回调给的是 JSON 字符串：处理了是 "\"true\""，没处理是 "\"false\""
            boolean handled = value != null && value.contains("true");
            if (!handled) {
                runOnUiThread(this::finish);
            }
        });
    }
}
