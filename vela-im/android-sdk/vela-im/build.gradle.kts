plugins { id("com.android.library"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "com.vela.im"
    compileSdk = 35
    defaultConfig { minSdk = 23; consumerProguardFiles("consumer-rules.pro") }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
dependencies {
    api("com.tencent.imsdk:imsdk-plus:9.1.7818")
    api("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
}
