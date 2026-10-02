/**
 * 天气查询
 *
 * ## 数据源：Open-Meteo
 *
 * 选它的理由：
 *   - **不需要 API Key**，非商业免费
 *   - **多城市一次请求**：latitude/longitude 支持逗号分隔，3 个城市仍是 1 个请求
 *   - 数据来自官方气象机构（含中国 CMA）
 *
 * ## 两段式调用
 *
 *   1. 地理编码（城市名 -> 经纬度）：**只在设置里添加城市时调一次**，
 *      结果存进配置，之后不再调用。
 *   2. 取天气：每次查询天气发 **1 个请求**，可同时带回全部城市。
 *
 * 因此日常使用（已配置好城市）时，一次「天气」点击 = 1 个请求，约 1~2 KB。
 *
 * ## 缓存
 *
 * 同一批城市 1 小时内重复查询直接复用结果。天气本身不会分钟级变化，
 * 这样连点也不会产生多余请求。
 */

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** 结果缓存时长：1 小时。 */
export const CACHE_TTL_MS = 60 * 60 * 1000;

/** 一次请求的超时（毫秒）。超过就按失败处理，避免气泡一直空等。 */
const TIMEOUT_MS = 8000;

/** 最多可配置的城市数。 */
export const MAX_CITIES = 3;

/* ---------- 中文地名辅助表 ---------- */

/**
 * 常见中国城市的省份对照。
 *
 * 用途：两个汉字的城市名（滨州、德州、柳州…）在 GeoNames 索引里
 * 走「2 字符精确匹配」容易落空，补上省份限定后长度 >= 3，
 * 改为前缀匹配，命中率显著提高。
 *
 * 只收录**地级市**，不必穷举——查不到时用户还可以自己写
 * 「城市, 省份」，或用拼音。
 */
const CN_PROVINCE_BY_CITY = {
  // 山东
  滨州: '山东', 德州: '山东', 聊城: '山东', 菏泽: '山东', 日照: '山东',
  临沂: '山东', 泰安: '山东', 威海: '山东', 东营: '山东', 枣庄: '山东',
  // 江苏
  苏州: '江苏', 无锡: '江苏', 常州: '江苏', 南通: '江苏', 徐州: '江苏',
  盐城: '江苏', 扬州: '江苏', 镇江: '江苏', 泰州: '江苏', 宿迁: '江苏',
  连云港: '江苏', 淮安: '江苏',
  // 浙江
  宁波: '浙江', 温州: '浙江', 嘉兴: '浙江', 湖州: '浙江', 绍兴: '浙江',
  金华: '浙江', 衢州: '浙江', 舟山: '浙江', 台州: '浙江', 丽水: '浙江',
  // 广东
  深圳: '广东', 珠海: '广东', 汕头: '广东', 佛山: '广东', 韶关: '广东',
  湛江: '广东', 肇庆: '广东', 江门: '广东', 茂名: '广东', 惠州: '广东',
  梅州: '广东', 汕尾: '广东', 河源: '广东', 阳江: '广东', 清远: '广东',
  东莞: '广东', 中山: '广东', 潮州: '广东', 揭阳: '广东', 云浮: '广东',
  // 河北
  唐山: '河北', 秦皇岛: '河北', 邯郸: '河北', 邢台: '河北', 保定: '河北',
  张家口: '河北', 承德: '河北', 沧州: '河北', 廊坊: '河北', 衡水: '河北',
  // 河南
  开封: '河南', 洛阳: '河南', 平顶山: '河南', 安阳: '河南', 鹤壁: '河南',
  新乡: '河南', 焦作: '河南', 濮阳: '河南', 许昌: '河南', 漯河: '河南',
  三门峡: '河南', 南阳: '河南', 商丘: '河南', 信阳: '河南', 周口: '河南',
  驻马店: '河南',
  // 湖北
  黄石: '湖北', 十堰: '湖北', 宜昌: '湖北', 襄阳: '湖北', 鄂州: '湖北',
  荆门: '湖北', 孝感: '湖北', 荆州: '湖北', 黄冈: '湖北', 咸宁: '湖北',
  随州: '湖北',
  // 湖南
  株洲: '湖南', 湘潭: '湖南', 衡阳: '湖南', 邵阳: '湖南', 岳阳: '湖南',
  常德: '湖南', 张家界: '湖南', 益阳: '湖南', 郴州: '湖南', 永州: '湖南',
  怀化: '湖南', 娄底: '湖南',
  // 四川
  自贡: '四川', 攀枝花: '四川', 泸州: '四川', 德阳: '四川', 绵阳: '四川',
  广元: '四川', 遂宁: '四川', 内江: '四川', 乐山: '四川', 南充: '四川',
  眉山: '四川', 宜宾: '四川', 广安: '四川', 达州: '四川', 雅安: '四川',
  巴中: '四川', 资阳: '四川',
  // 安徽
  芜湖: '安徽', 蚌埠: '安徽', 淮南: '安徽', 马鞍山: '安徽', 淮北: '安徽',
  铜陵: '安徽', 安庆: '安徽', 黄山: '安徽', 滁州: '安徽', 阜阳: '安徽',
  宿州: '安徽', 六安: '安徽', 亳州: '安徽', 池州: '安徽', 宣城: '安徽',
  // 福建
  厦门: '福建', 莆田: '福建', 三明: '福建', 泉州: '福建', 漳州: '福建',
  南平: '福建', 龙岩: '福建', 宁德: '福建',
  // 江西
  景德镇: '江西', 萍乡: '江西', 九江: '江西', 新余: '江西', 鹰潭: '江西',
  赣州: '江西', 吉安: '江西', 宜春: '江西', 抚州: '江西', 上饶: '江西',
  // 辽宁
  大连: '辽宁', 鞍山: '辽宁', 抚顺: '辽宁', 本溪: '辽宁', 丹东: '辽宁',
  锦州: '辽宁', 营口: '辽宁', 阜新: '辽宁', 辽阳: '辽宁', 盘锦: '辽宁',
  铁岭: '辽宁', 朝阳: '辽宁', 葫芦岛: '辽宁',
  // 吉林
  吉林: '吉林', 四平: '吉林', 辽源: '吉林', 通化: '吉林', 白山: '吉林',
  松原: '吉林', 白城: '吉林',
  // 黑龙江
  齐齐哈尔: '黑龙江', 鸡西: '黑龙江', 鹤岗: '黑龙江', 双鸭山: '黑龙江',
  大庆: '黑龙江', 伊春: '黑龙江', 佳木斯: '黑龙江', 七台河: '黑龙江',
  牡丹江: '黑龙江', 黑河: '黑龙江', 绥化: '黑龙江',
  // 山西
  大同: '山西', 阳泉: '山西', 长治: '山西', 晋城: '山西', 朔州: '山西',
  晋中: '山西', 运城: '山西', 忻州: '山西', 临汾: '山西', 吕梁: '山西',
  // 陕西
  铜川: '陕西', 宝鸡: '陕西', 咸阳: '陕西', 渭南: '陕西', 延安: '陕西',
  汉中: '陕西', 榆林: '陕西', 安康: '陕西', 商洛: '陕西',
  // 甘肃 / 青海 / 宁夏 / 新疆
  嘉峪关: '甘肃', 金昌: '甘肃', 白银: '甘肃', 天水: '甘肃', 武威: '甘肃',
  张掖: '甘肃', 平凉: '甘肃', 酒泉: '甘肃', 庆阳: '甘肃', 定西: '甘肃',
  陇南: '甘肃', 西宁: '青海', 海东: '青海',
  石嘴山: '宁夏', 吴忠: '宁夏', 固原: '宁夏', 中卫: '宁夏',
  克拉玛依: '新疆', 吐鲁番: '新疆', 哈密: '新疆', 昌吉: '新疆',
  博尔塔拉: '新疆', 阿克苏: '新疆', 喀什: '新疆', 和田: '新疆',
  // 广西 / 贵州 / 云南 / 海南
  柳州: '广西', 桂林: '广西', 梧州: '广西', 北海: '广西', 防城港: '广西',
  钦州: '广西', 贵港: '广西', 玉林: '广西', 百色: '广西', 贺州: '广西',
  河池: '广西', 来宾: '广西', 崇左: '广西',
  六盘水: '贵州', 遵义: '贵州', 安顺: '贵州', 毕节: '贵州', 铜仁: '贵州',
  曲靖: '云南', 玉溪: '云南', 保山: '云南', 昭通: '云南', 丽江: '云南',
  普洱: '云南', 临沧: '云南',
  三亚: '海南', 三沙: '海南', 儋州: '海南',
  // 内蒙古 / 西藏
  包头: '内蒙古', 乌海: '内蒙古', 赤峰: '内蒙古', 通辽: '内蒙古',
  鄂尔多斯: '内蒙古', 呼伦贝尔: '内蒙古', 巴彦淖尔: '内蒙古', 乌兰察布: '内蒙古',
  日喀则: '西藏', 昌都: '西藏', 林芝: '西藏', 山南: '西藏', 那曲: '西藏',
  // 直辖市与特别行政区
  北京: '北京市', 上海: '上海市', 天津: '天津市', 重庆: '重庆市',
  香港: '香港', 澳门: '澳门', 台北: '台湾', 高雄: '台湾', 台中: '台湾',
};

/**
 * 两个汉字地名的拼音兜底。
 *
 * 中文名匹配不上时，用拼音再试一次（GeoNames 的主名常是拼音形式）。
 * 只覆盖两类：上面的省份表里的城市，以及其他容易被输入的地名。
 */
const CN_PINYIN = {
  滨州: 'Binzhou', 德州: 'Dezhou', 聊城: 'Liaocheng', 菏泽: 'Heze',
  日照: 'Rizhao', 临沂: 'Linyi', 泰安: 'Taian', 威海: 'Weihai',
  东营: 'Dongying', 枣庄: 'Zaozhuang',
  苏州: 'Suzhou', 无锡: 'Wuxi', 常州: 'Changzhou', 南通: 'Nantong',
  徐州: 'Xuzhou', 盐城: 'Yancheng', 扬州: 'Yangzhou', 镇江: 'Zhenjiang',
  泰州: 'Taizhou', 宿迁: 'Suqian', 连云港: 'Lianyungang', 淮安: 'Huaian',
  宁波: 'Ningbo', 温州: 'Wenzhou', 嘉兴: 'Jiaxing', 湖州: 'Huzhou',
  绍兴: 'Shaoxing', 金华: 'Jinhua', 衢州: 'Quzhou', 舟山: 'Zhoushan',
  台州: 'Taizhou', 丽水: 'Lishui',
  深圳: 'Shenzhen', 珠海: 'Zhuhai', 汕头: 'Shantou', 佛山: 'Foshan',
  韶关: 'Shaoguan', 湛江: 'Zhanjiang', 肇庆: 'Zhaoqing', 江门: 'Jiangmen',
  茂名: 'Maoming', 惠州: 'Huizhou', 梅州: 'Meizhou', 汕尾: 'Shanwei',
  河源: 'Heyuan', 阳江: 'Yangjiang', 清远: 'Qingyuan', 东莞: 'Dongguan',
  中山: 'Zhongshan', 潮州: 'Chaozhou', 揭阳: 'Jieyang', 云浮: 'Yunfu',
  唐山: 'Tangshan', 秦皇岛: 'Qinhuangdao', 邯郸: 'Handan', 邢台: 'Xingtai',
  保定: 'Baoding', 张家口: 'Zhangjiakou', 承德: 'Chengde', 沧州: 'Cangzhou',
  廊坊: 'Langfang', 衡水: 'Hengshui',
  开封: 'Kaifeng', 洛阳: 'Luoyang', 平顶山: 'Pingdingshan', 安阳: 'Anyang',
  鹤壁: 'Hebi', 新乡: 'Xinxiang', 焦作: 'Jiaozuo', 濮阳: 'Puyang',
  许昌: 'Xuchang', 漯河: 'Luohe', 三门峡: 'Sanmenxia', 南阳: 'Nanyang',
  商丘: 'Shangqiu', 信阳: 'Xinyang', 周口: 'Zhoukou', 驻马店: 'Zhumadian',
  黄石: 'Huangshi', 十堰: 'Shiyan', 宜昌: 'Yichang', 襄阳: 'Xiangyang',
  鄂州: 'Ezhou', 荆门: 'Jingmen', 孝感: 'Xiaogan', 荆州: 'Jingzhou',
  黄冈: 'Huanggang', 咸宁: 'Xianning', 随州: 'Suizhou',
  株洲: 'Zhuzhou', 湘潭: 'Xiangtan', 衡阳: 'Hengyang', 邵阳: 'Shaoyang',
  岳阳: 'Yueyang', 常德: 'Changde', 张家界: 'Zhangjiajie', 益阳: 'Yiyang',
  郴州: 'Chenzhou', 永州: 'Yongzhou', 怀化: 'Huaihua', 娄底: 'Loudi',
  自贡: 'Zigong', 攀枝花: 'Panzhihua', 泸州: 'Luzhou', 德阳: 'Deyang',
  绵阳: 'Mianyang', 广元: 'Guangyuan', 遂宁: 'Suining', 内江: 'Neijiang',
  乐山: 'Leshan', 南充: 'Nanchong', 眉山: 'Meishan', 宜宾: 'Yibin',
  广安: 'Guangan', 达州: 'Dazhou', 雅安: 'Yaan', 巴中: 'Bazhong',
  资阳: 'Ziyang',
  芜湖: 'Wuhu', 蚌埠: 'Bengbu', 淮南: 'Huainan', 马鞍山: 'Maanshan',
  淮北: 'Huaibei', 铜陵: 'Tongling', 安庆: 'Anqing', 黄山: 'Huangshan',
  滁州: 'Chuzhou', 阜阳: 'Fuyang', 宿州: 'Suzhou', 六安: 'Luan',
  亳州: 'Bozhou', 池州: 'Chizhou', 宣城: 'Xuancheng',
  厦门: 'Xiamen', 莆田: 'Putian', 三明: 'Sanming', 泉州: 'Quanzhou',
  漳州: 'Zhangzhou', 南平: 'Nanping', 龙岩: 'Longyan', 宁德: 'Ningde',
  景德镇: 'Jingdezhen', 萍乡: 'Pingxiang', 九江: 'Jiujiang', 新余: 'Xinyu',
  鹰潭: 'Yingtan', 赣州: 'Ganzhou', 吉安: 'Jian', 宜春: 'Yichun',
  抚州: 'Fuzhou', 上饶: 'Shangrao',
  大连: 'Dalian', 鞍山: 'Anshan', 抚顺: 'Fushun', 本溪: 'Benxi',
  丹东: 'Dandong', 锦州: 'Jinzhou', 营口: 'Yingkou', 阜新: 'Fuxin',
  辽阳: 'Liaoyang', 盘锦: 'Panjin', 铁岭: 'Tieling', 朝阳: 'Chaoyang',
  葫芦岛: 'Huludao',
  四平: 'Siping', 辽源: 'Liaoyuan', 通化: 'Tonghua', 白山: 'Baishan',
  松原: 'Songyuan', 白城: 'Baicheng',
  齐齐哈尔: 'Qiqihar', 鸡西: 'Jixi', 鹤岗: 'Hegang', 双鸭山: 'Shuangyashan',
  大庆: 'Daqing', 伊春: 'Yichun', 佳木斯: 'Jiamusi', 七台河: 'Qitaihe',
  牡丹江: 'Mudanjiang', 黑河: 'Heihe', 绥化: 'Suihua',
  大同: 'Datong', 阳泉: 'Yangquan', 长治: 'Changzhi', 晋城: 'Jincheng',
  朔州: 'Shuozhou', 晋中: 'Jinzhong', 运城: 'Yuncheng', 忻州: 'Xinzhou',
  临汾: 'Linfen', 吕梁: 'Lvliang',
  铜川: 'Tongchuan', 宝鸡: 'Baoji', 咸阳: 'Xianyang', 渭南: 'Weinan',
  延安: 'Yanan', 汉中: 'Hanzhong', 榆林: 'Yulin', 安康: 'Ankang',
  商洛: 'Shangluo',
  嘉峪关: 'Jiayuguan', 金昌: 'Jinchang', 白银: 'Baiyin', 天水: 'Tianshui',
  武威: 'Wuwei', 张掖: 'Zhangye', 平凉: 'Pingliang', 酒泉: 'Jiuquan',
  庆阳: 'Qingyang', 定西: 'Dingxi', 陇南: 'Longnan',
  西宁: 'Xining', 海东: 'Haidong',
  石嘴山: 'Shizuishan', 吴忠: 'Wuzhong', 固原: 'Guyuan', 中卫: 'Zhongwei',
  克拉玛依: 'Karamay', 吐鲁番: 'Turpan', 哈密: 'Hami', 昌吉: 'Changji',
  阿克苏: 'Aksu', 喀什: 'Kashgar', 和田: 'Hotan',
  柳州: 'Liuzhou', 桂林: 'Guilin', 梧州: 'Wuzhou', 北海: 'Beihai',
  防城港: 'Fangchenggang', 钦州: 'Qinzhou', 贵港: 'Guigang', 玉林: 'Yulin',
  百色: 'Baise', 贺州: 'Hezhou', 河池: 'Hechi', 来宾: 'Laibin',
  崇左: 'Chongzuo',
  六盘水: 'Liupanshui', 遵义: 'Zunyi', 安顺: 'Anshun', 毕节: 'Bijie',
  铜仁: 'Tongren',
  曲靖: 'Qujing', 玉溪: 'Yuxi', 保山: 'Baoshan', 昭通: 'Zhaotong',
  丽江: 'Lijiang', 普洱: 'Puer', 临沧: 'Lincang',
  三亚: 'Sanya', 三沙: 'Sansha', 儋州: 'Danzhou',
  包头: 'Baotou', 乌海: 'Wuhai', 赤峰: 'Chifeng', 通辽: 'Tongliao',
  鄂尔多斯: 'Ordos', 呼伦贝尔: 'Hulunbuir', 巴彦淖尔: 'Bayannur',
  乌兰察布: 'Ulanqab',
  日喀则: 'Shigatse', 昌都: 'Qamdo', 林芝: 'Nyingchi', 山南: 'Shannan',
  那曲: 'Nagqu',
};

/* ---------- WMO 天气码 -> 中文 ---------- */

/**
 * WMO 4677 天气码对照表（Open-Meteo 用这套码）。
 * 在本地映射，不额外发请求。
 */
const WMO = {
  0:  { text: '晴',        icon: '☀️' },
  1:  { text: '晴间多云',   icon: '🌤️' },
  2:  { text: '多云',      icon: '⛅' },
  3:  { text: '阴',        icon: '☁️' },
  45: { text: '雾',        icon: '🌫️' },
  48: { text: '雾凇',      icon: '🌫️' },
  51: { text: '毛毛雨',     icon: '🌦️' },
  53: { text: '小雨',      icon: '🌦️' },
  55: { text: '中雨',      icon: '🌧️' },
  56: { text: '冻毛毛雨',   icon: '🌧️' },
  57: { text: '冻雨',      icon: '🌧️' },
  61: { text: '小雨',      icon: '🌦️' },
  63: { text: '中雨',      icon: '🌧️' },
  65: { text: '大雨',      icon: '🌧️' },
  66: { text: '冻雨',      icon: '🌧️' },
  67: { text: '强冻雨',     icon: '🌧️' },
  71: { text: '小雪',      icon: '🌨️' },
  73: { text: '中雪',      icon: '🌨️' },
  75: { text: '大雪',      icon: '❄️' },
  77: { text: '米雪',      icon: '🌨️' },
  80: { text: '阵雨',      icon: '🌦️' },
  81: { text: '强阵雨',     icon: '🌧️' },
  82: { text: '暴雨',      icon: '⛈️' },
  85: { text: '阵雪',      icon: '🌨️' },
  86: { text: '强阵雪',     icon: '❄️' },
  95: { text: '雷阵雨',     icon: '⛈️' },
  96: { text: '雷阵雨伴冰雹', icon: '⛈️' },
  99: { text: '强雷暴伴冰雹', icon: '⛈️' },
};

/** 天气码 -> { text, icon }；未知码退回「未知」。 */
export function describeWeatherCode(code) {
  return WMO[code] || { text: '未知', icon: '❓' };
}

/* ---------- 缓存 ---------- */

/** key = 城市坐标串，value = { at, result } */
const cache = new Map();

/** 清空缓存（测试与「强制刷新」用）。 */
export function clearCache() {
  cache.clear();
}

/** 城市列表 -> 稳定的缓存 key。 */
function cacheKey(cities) {
  return cities
    .map((c) => `${Number(c.latitude).toFixed(3)},${Number(c.longitude).toFixed(3)}`)
    .join('|');
}

/* ---------- 网络 ---------- */

/**
 * 带超时的 fetch。
 *
 * 必须自己加超时：网络不可达时 fetch 可能长时间挂起，
 * 桌面宠物的气泡会一直停在「查询中」。
 */
async function fetchWithTimeout(url, ms = TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 地理编码 ---------- */

/**
 * 按城市名搜索候选地点。
 *
 * 返回 `[{ name, latitude, longitude, admin1, country, timezone }]`。
 *
 * `language=zh` 让地名返回中文；不传 `count` 用默认 10 条，
 * 便于用户在有歧义时（如「朝阳」）自己挑。
 *
 * 调用方应当让**用户确认候选**，不要自动取第一条——
 * 同名地点很多（朝阳区 vs 朝阳市）。
 *
 * @param {string} query 城市名，或「城市, 国家/省份」形式
 * @returns {Promise<Array>}
 */
export async function searchCity(query) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];

  // 多策略依次尝试，任一有结果就返回并按相关性排序。
  for (const attempt of geoAttempts(q)) {
    const list = await tryGeo(attempt);
    if (list.length) return rankResults(list, q);
  }
  return [];
}

/**
 * 生成地理编码的尝试列表。
 *
 * ## 为什么要多次尝试
 *
 * Open-Meteo（ GeoNames ）的匹配规则是：
 *   - **2 个字符 = 精确匹配**，3 个及以上 = 前缀匹配
 *   - 匹配针对索引里的**主名**，而中文名往往只是 alternate name
 *
 * 于是「滨州」这类**两个汉字**的地名直接查不到——2 字符走精确匹配，
 * 主名又是拼音形式，就对不上。
 *
 * ## 为什么拼音排在前面
 *
 * 实测表明**拼音命中的更准**：中文名匹配经常返回一堆同名小地方，
 * 而拼音对应的往往是 GeoNames 的主条目（人口更多、更可能是用户想找的市）。
 * 因此对于已知拼音的中文地名，先用拼音查。
 *
 * 顺序：拼音（若已知）-> 原样 -> 补省份 -> 再试一次拼音
 *
 * @param {string} q 用户输入
 * @returns {string[]} 依次尝试的查询串
 */
function geoAttempts(q) {
  const list = [];
  const hasQualifier = q.includes(',') || q.includes('，');
  const py = CN_PINYIN[q];

  // 用户已写「城市, 省份」时尊重原样，不做任何改写
  if (hasQualifier) return [q];

  // 拼音优先：命中更准
  if (py) list.push(py);

  list.push(q);

  // 补省份：长度变 >= 3，改走前缀匹配
  const province = CN_PROVINCE_BY_CITY[q];
  if (province) list.push(`${q}, ${province}`);

  // 拼音兜底（前面已加过就不重复）
  if (py && !list.includes(py)) list.push(py);

  return list;
}

/** 单次地理编码请求。 */
async function tryGeo(name) {
  const url = `${GEO_URL}?name=${encodeURIComponent(name)}` +
              `&count=10&language=zh&format=json`;

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`地理编码失败：HTTP ${res.status}`);

  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];

  return results.map((r) => ({
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    // 省份/州，用于区分同名地点
    admin1: r.admin1 || '',
    country: r.country || '',
    timezone: r.timezone || '',
    population: r.population || 0,
  }));
}

/**
 * 按「用户最可能想要的」排序。
 *
 * GeoNames 的结果里同一个名字可能对应村、镇、区、市……
 * 默认顺序未必把**人口最多的那个**放前面。这里按：
 *   1. 名称与查询完全一致（或包含）优先
 *   2. 人口多的优先
 * 让真正想找的城市冒到最上面，减少用户翻找。
 *
 * @param {Array} list tryGeo 的结果
 * @param {string} q 用户原始输入
 */
function rankResults(list, q) {
  const norm = (s) => String(s || '').replace(/[市县区盟州地区]/g, '');
  const target = norm(q);

  return list.slice().sort((a, b) => {
    const aExact = norm(a.name) === target ? 1 : 0;
    const bExact = norm(b.name) === target ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    return (b.population || 0) - (a.population || 0);
  });
}

/* ---------- 取天气 ---------- */

/**
 * 查询多个城市的当前天气与今日温度区间。
 *
 * **一个请求带走全部城市**：latitude/longitude 用逗号分隔时，
 * Open-Meteo 返回数组，顺序与入参一致。
 *
 * @param {Array<{name:string, latitude:number, longitude:number}>} cities
 * @returns {Promise<Array<{name, code, text, icon, temp, feels, humidity, wind, tMax, tMin}>>}
 */
export async function fetchWeather(cities) {
  if (!cities || !cities.length) return [];

  // 坐标用**未编码**的逗号分隔。
  //
  // URLSearchParams 会把逗号转义成 %2C，虽然服务端解码后等价，
  // 但多城市依赖「逗号即分隔符」这一语义，明文逗号更稳妥、
  // 也便于在日志里直接看出请求了几个城市。
  const lat = cities.map((c) => c.latitude).join(',');
  const lon = cities.map((c) => c.longitude).join(',');

  const params = new URLSearchParams({
    current: [
      'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
      'weather_code', 'wind_speed_10m', 'wind_direction_10m',
      'surface_pressure', 'precipitation',
    ].join(','),
    // 今日 + 明日：日报里给一句"明天"的提示很有用
    daily: [
      'temperature_2m_max', 'temperature_2m_min',
      'precipitation_probability_max', 'sunrise', 'sunset',
      'uv_index_max', 'wind_speed_10m_max',
    ].join(','),
    timezone: 'auto',
    forecast_days: '2',
  });

  const url = `${FORECAST_URL}?latitude=${lat}&longitude=${lon}&${params}`;

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`天气查询失败：HTTP ${res.status}`);

  const data = await res.json();

  // 单城市时 Open-Meteo 返回**对象**，多城市返回**数组**。
  // 这里统一成数组，否则单城市场景会静默取不到数据。
  const list = Array.isArray(data) ? data : [data];

  return cities.map((city, i) => {
    const d = list[i];
    if (!d || !d.current) {
      return { ...city, ok: false };
    }
    const code = d.current.weather_code;
    const desc = describeWeatherCode(code);
    const daily = d.daily || {};
    const first = (arr) => (Array.isArray(arr) ? arr[0] : undefined);

    return {
      ...city,
      ok: true,
      code,
      text: desc.text,
      icon: desc.icon,
      // 当前实况
      temp: d.current.temperature_2m,
      feels: d.current.apparent_temperature,
      humidity: d.current.relative_humidity_2m,
      wind: d.current.wind_speed_10m,
      windDir: d.current.wind_direction_10m,
      pressure: d.current.surface_pressure,
      precip: d.current.precipitation,
      // 今日
      tMax: first(daily.temperature_2m_max),
      tMin: first(daily.temperature_2m_min),
      precipProb: first(daily.precipitation_probability_max),
      uv: first(daily.uv_index_max),
      sunrise: first(daily.sunrise),
      sunset: first(daily.sunset),
      // 明日
      tMaxTomorrow: Array.isArray(daily.temperature_2m_max)
        ? daily.temperature_2m_max[1] : undefined,
      tMinTomorrow: Array.isArray(daily.temperature_2m_min)
        ? daily.temperature_2m_min[1] : undefined,
    };
  });
}

/**
 * 带缓存的查询（对外主入口）。
 *
 * 命中缓存（1 小时内）时**不发任何请求**。
 *
 * @param {Array} cities
 * @param {{force?: boolean, now?: number}} opts
 * @returns {Promise<{ok: boolean, items: Array, cached: boolean, error?: string}>}
 */
export async function getWeather(cities, opts = {}) {
  const list = (cities || []).filter(Boolean);
  if (!list.length) {
    return { ok: false, items: [], cached: false, error: 'no-city' };
  }

  const key = cacheKey(list);
  const now = opts.now ?? Date.now();

  if (!opts.force) {
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      return { ok: true, items: hit.items, cached: true };
    }
  }

  try {
    const items = await fetchWeather(list);
    const ok = items.some((it) => it.ok);
    if (ok) cache.set(key, { at: now, items });
    return { ok, items, cached: false, error: ok ? undefined : 'no-data' };
  } catch (e) {
    return { ok: false, items: [], cached: false, error: String(e?.message || e) };
  }
}

/* ---------- 生活提醒 ---------- */

/**
 * 按体感温度给出穿衣建议。
 *
 * 用**体感温度**而非气温：同样 5℃，有风时体感可能接近 0℃，
 * 只按气温给建议会穿少。
 *
 * 分档参考中国气象局的「穿衣指数」惯用区间。
 */
export function clothingAdvice(feelsLike) {
  const t = Number(feelsLike);
  if (!Number.isFinite(t)) return '';
  if (t >= 30) return '短袖短裤，注意防暑';
  if (t >= 26) return '短袖薄衫';
  if (t >= 21) return '长袖T恤或薄外套';
  if (t >= 16) return '薄外套或针织衫';
  if (t >= 11) return '夹克加毛衣';
  if (t >= 6)  return '厚外套或大衣';
  if (t >= 0)  return '棉衣羽绒服';
  if (t >= -9) return '厚羽绒服，注意保暖';
  return '极寒，尽量减少外出';
}

/**
 * 按天气码给出是否需要带伞。
 *
 * @returns {{need: boolean, text: string}} need 为真时提示带伞
 */
export function umbrellaAdvice(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return { need: false, text: '' };

  // 雷暴
  if (c >= 95) return { need: true, text: '有雷雨，带伞并避免户外' };
  // 阵雨类
  if (c === 80 || c === 81 || c === 82) return { need: true, text: '有阵雨，记得带伞' };
  // 降雪
  if (c >= 71 && c <= 77) return { need: true, text: '有雪，注意路滑' };
  if (c === 85 || c === 86) return { need: true, text: '有阵雪，注意保暖防滑' };
  // 雨类（毛毛雨 ~ 冻雨）
  if (c >= 51 && c <= 67) {
    const heavy = c === 65 || c === 67 || c === 55;
    return { need: true, text: heavy ? '雨较大，务必带伞' : '可能有雨，建议带伞' };
  }
  // 雾
  if (c === 45 || c === 48) return { need: false, text: '有雾，出行注意能见度' };
  return { need: false, text: '' };
}

/**
 * 按风速给出提醒（km/h）。
 */
export function windAdvice(windKmh) {
  const w = Number(windKmh);
  if (!Number.isFinite(w)) return '';
  if (w >= 62) return '大风，尽量少出门';
  if (w >= 39) return '风较大，注意防风';
  if (w >= 20) return '有点风';
  return '';
}

/** 风向角度 -> 中文方位（8 方位）。 */
export function windDirectionText(deg) {
  const d = Number(deg);
  if (!Number.isFinite(d)) return '';
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  // 每个方位 45°，偏移 22.5° 让"北"覆盖 337.5~22.5
  const i = Math.round(((d % 360) + 360) % 360 / 45) % 8;
  return dirs[i] + '风';
}

/**
 * 紫外线提醒。
 *
 * Open-Meteo 的 uv_index_max 是当日最大值，按 WHO 分级：
 *   0–2 低 / 3–5 中等 / 6–7 高 / 8–10 很高 / 11+ 极高
 */
export function uvAdvice(uv) {
  const v = Number(uv);
  if (!Number.isFinite(v)) return '';
  if (v >= 11) return '紫外线极强，避免暴晒';
  if (v >= 8) return '紫外线很强，注意防晒';
  if (v >= 6) return '紫外线较强，建议防晒';
  if (v >= 3) return '紫外线中等';
  return '';
}

/**
 * 按湿度给出提醒（%）。
 */
export function humidityAdvice(rh) {
  const v = Number(rh);
  if (!Number.isFinite(v)) return '';
  if (v >= 85) return '空气很潮湿';
  if (v >= 70) return '湿度偏高';
  if (v <= 25) return '空气干燥，注意补水';
  if (v <= 35) return '偏干，记得多喝水';
  return '';
}

/**
 * 气压提醒（hPa）。低气压容易让人犯困、头痛。
 */
export function pressureAdvice(hpa) {
  const v = Number(hpa);
  if (!Number.isFinite(v)) return '';
  if (v <= 995) return '气压偏低，容易疲倦';
  return '';
}

/**
 * 昼夜温差提醒。
 */
export function diurnalAdvice(tMax, tMin) {
  const a = Number(tMax);
  const b = Number(tMin);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  const diff = a - b;
  if (diff >= 12) return `昼夜温差 ${Math.round(diff)}℃，注意增减衣物`;
  if (diff >= 9) return '早晚较凉，备件外套';
  return '';
}

/**
 * 明日天气提示。
 */
export function tomorrowAdvice(it) {
  const a = Number(it?.tMaxTomorrow);
  const b = Number(it?.tMinTomorrow);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  return `明天 ${Math.round(b)}~${Math.round(a)}℃`;
}

/**
 * 汇总一条天气结果的生活提醒。
 *
 * 按「重要程度」排序并**限制条数**：气泡空间有限，
 * 全部塞进去会变成一大段字，反而没人看。
 * 优先级：降雨/降雪 > 穿衣 > 温差 > 紫外线 > 干燥/潮湿 > 风力 > 气压。
 *
 * @param {object} it
 * @param {{max?: number}} opts max 最多返回几条（默认 3）
 * @returns {string} 形如 `建议：夹克加毛衣；可能有雨，建议带伞`
 */
export function lifeAdvice(it, opts = {}) {
  if (!it || !it.ok) return '';
  const max = opts.max ?? 3;

  const umb = umbrellaAdvice(it.code);
  const cloth = clothingAdvice(it.feels ?? it.temp);

  const ranked = [
    umb.need ? umb.text : '',
    cloth,
    diurnalAdvice(it.tMax, it.tMin),
    uvAdvice(it.uv),
    humidityAdvice(it.humidity),
    windAdvice(it.wind),
    pressureAdvice(it.pressure),
  ].filter(Boolean);

  // 有降水时不再重复说风（伞的提醒更重要，句子也别太长）
  const parts = ranked.slice(0, max);
  return parts.length ? `建议：${parts.join('；')}` : '';
}

/* ---------- 展示格式 ---------- */

/** 四舍五入到整数，并把 undefined 显示成 `--`。 */
function n(v) {
  return Number.isFinite(v) ? Math.round(v) : null;
}

/**
 * 把一条天气结果格式化成气泡里的**城市天气行**。
 *
 * 形如：
 * ```
 * 北京 ☀️ 晴  16~26℃  体感19℃
 * 湿度45%  东南风12km/h  降水概率10%
 * ```
 *
 * 分两行而不是一行：一行太长在窄气泡里会折成一团，读起来费劲。
 * 第一行是「现在怎么样」，第二行是「具体数据」。
 *
 * @param {object} it fetchWeather 的单项
 * @param {{compact?: boolean}} opts compact 用于窗口很小时省略次要信息
 * @returns {string[]} 行数组
 */
export function formatWeatherLines(it, opts = {}) {
  if (!it || !it.ok) {
    return [`${it?.name || '未知'}：暂无数据`];
  }
  const t = n(it.temp);
  const tMax = n(it.tMax);
  const tMin = n(it.tMin);

  // 第一行：城市 + 天气 + 温度区间
  let head = `${it.name} ${it.icon} ${it.text}`;
  if (tMin !== null && tMax !== null) head += `  ${tMin}~${tMax}℃`;
  else if (t !== null) head += `  ${t}℃`;

  if (opts.compact) return [head];

  // 第二行：详细数据
  const feels = n(it.feels);
  const hum = n(it.humidity);
  const wind = n(it.wind);
  const dir = windDirectionText(it.windDir);
  const prob = n(it.precipProb);

  const detail = [];
  if (feels !== null) detail.push(`体感${feels}℃`);
  if (hum !== null) detail.push(`湿度${hum}%`);
  if (wind !== null) detail.push(`${dir}${wind}km/h`);
  if (prob !== null && prob > 0) detail.push(`降水概率${prob}%`);

  return detail.length ? [head, detail.join('  ')] : [head];
}

/**
 * 兼容旧调用：返回单行（把两行用空格接起来）。
 * @deprecated 新代码请用 formatWeatherLines
 */
export function formatWeatherLine(it, opts = {}) {
  return formatWeatherLines(it, opts).join('  ');
}

/**
 * 生成气泡要显示的整段文字。
 *
 * 结构：
 * ```
 * 博士，这是今天的天气情况：          ← 固定问候语
 * 北京 ☀️ 晴  16~26℃                  ← 城市行（现在怎么样）
 * 体感19℃  湿度45%  东南风12km/h      ← 数据行（详细指标）
 * 建议：夹克加毛衣；可能有雨，建议带伞   ← 生活提醒
 * ```
 *
 * 每个城市固定 3 行（compact 时压成 1 行）。
 *
 * @param {Array} items
 * @param {{compact?: boolean, greeting?: string, advice?: boolean, adviceMax?: number}} opts
 * @returns {string[]} 行数组
 */
export function formatWeatherReport(items, opts = {}) {
  const greeting = opts.greeting ?? '博士，这是今天的天气情况：';
  const withAdvice = opts.advice !== false && !opts.compact;

  const lines = [greeting];
  for (const it of items) {
    // 城市行 + 数据行
    lines.push(...formatWeatherLines(it, opts));
    if (withAdvice) {
      const tip = lifeAdvice(it, { max: opts.adviceMax ?? 3 });
      // 缩进显示，与天气行区分开
      if (tip) lines.push(`  ${tip}`);
    }
  }
  return lines;
}
