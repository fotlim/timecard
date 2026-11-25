# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# ---------------------------------------------------------------
# Capacitor 7：JS ↔ 原生桥全走反射 + @JavascriptInterface，
# 开 R8 后必须保住这些入口，否则 release 包一进 App 就白屏 / 插件全失效。
# ---------------------------------------------------------------
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.timecard.mobile.** { *; }

# 注解（@PluginMethod / @CapacitorPlugin 等）不能被裁掉
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod

# Cordova 兼容层同理
-keep class org.apache.cordova.** { *; }

# If you keep the line number information, uncomment this to
# preserve the original file name in stack traces.
#-keepattributes SourceFile,LineNumberTable
#-renamesourcefileattribute SourceFile
