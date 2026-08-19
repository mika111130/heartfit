const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

// ── API 키 ──
const AIR_API_URL =
  "https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getMsrstnAcctoRltmMesureDnsty";
const NEARBY_STATION_URL =
  "https://apis.data.go.kr/B552584/MsrstnInfoInqireSvc/getNearbyMsrstnList";
const RAW_KEY = process.env.AIR_API_KEY || "";

if (!RAW_KEY) {
  console.warn(
    "[경고] AIR_API_KEY 환경변수가 설정되지 않았습니다. 대기질/기상 API 호출이 실패합니다.",
  );
}

// ── OpenWeatherMap (무료 Current Weather API) ──
const OWM_KEY = ""; // 사용자가 키 없으면 기상청 API 사용

app.use(express.static(path.join(__dirname, "public")));

app.get(["/", "/index.html"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── 위경도 → TM 좌표 변환 (근사) ──
function wgs84ToTM(lat, lon) {
  // 한국 중부 좌표계(EPSG:2097) 근사 변환
  const tmX = (lon - 127.0) * 88361.4 + 200000;
  const tmY = (lat - 38.0) * 111195.1 + 500000;
  return { tmX: tmX.toFixed(3), tmY: tmY.toFixed(3) };
}

// ── 가까운 측정소 찾기 ──
async function findNearbyStation(lat, lon) {
  try {
    const { tmX, tmY } = wgs84ToTM(lat, lon);
    const response = await axios.get(
      `${NEARBY_STATION_URL}?serviceKey=${encodeURIComponent(RAW_KEY)}`,
      {
        params: {
          returnType: "json",
          tmX: tmX,
          tmY: tmY,
          ver: "1.1",
        },
      },
    );
    const items = response.data.response.body.items;
    if (items && items.length > 0) {
      console.log(
        `[측정소 탐색 성공] 가장 가까운 측정소: ${items[0].stationName} (${items[0].tm}km)`,
      );
      return items[0].stationName;
    }
  } catch (err) {
    console.log(`[측정소 탐색 실패] ${err.message} → 기본값 종로구 사용`);
  }
  return "종로구";
}

// ── 기상청 동네예보 API (초단기실황) ──
const KMA_API_URL =
  "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst";
const KMA_KEY = RAW_KEY; // 동일 공공데이터포털 인증키 사용 가능

// 위경도 → 기상청 격자 좌표 변환
function latLonToGrid(lat, lon) {
  const RE = 6371.00877;
  const GRID = 5.0;
  const SLAT1 = 30.0;
  const SLAT2 = 60.0;
  const OLON = 126.0;
  const OLAT = 38.0;
  const XO = 43;
  const YO = 136;

  const DEGRAD = Math.PI / 180.0;
  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD;
  const slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD;
  const olat = OLAT * DEGRAD;

  let sn =
    Math.tan(Math.PI * 0.25 + slat2 * 0.5) /
    Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);

  let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;

  const x = Math.floor(ra * Math.sin(theta) + XO + 0.5);
  const y = Math.floor(ro - ra * Math.cos(theta) + YO + 0.5);
  return { nx: x, ny: y };
}

// ── 기상청 날씨 데이터 조회 ──
async function getWeatherData(lat, lon) {
  try {
    const { nx, ny } = latLonToGrid(lat, lon);
    const now = new Date();
    // KST = UTC + 9
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);

    // 초단기실황은 매시 30분에 발표 → 현재 시각이 30분 이전이면 이전 시각 사용
    let hour = kst.getUTCHours();
    let minutes = kst.getUTCMinutes();
    if (minutes < 40) {
      hour = hour - 1;
      if (hour < 0) hour = 23;
    }

    const baseDate = `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, "0")}${String(kst.getUTCDate()).padStart(2, "0")}`;
    const baseTime = `${String(hour).padStart(2, "0")}00`;

    console.log(
      `[기상청 API 요청] 격자: (${nx}, ${ny}), 발표일시: ${baseDate} ${baseTime}`,
    );

    const response = await axios.get(
      `${KMA_API_URL}?serviceKey=${encodeURIComponent(KMA_KEY)}`,
      {
        params: {
          pageNo: "1",
          numOfRows: "10",
          dataType: "JSON",
          base_date: baseDate,
          base_time: baseTime,
          nx: nx,
          ny: ny,
        },
        timeout: 5000,
      },
    );

    const items = response.data.response.body.items.item;
    let temp = null,
      humidity = null,
      windSpeed = null;

    for (const item of items) {
      if (item.category === "T1H") temp = parseFloat(item.obsrValue); // 기온(℃)
      if (item.category === "REH") humidity = parseFloat(item.obsrValue); // 습도(%)
      if (item.category === "WSD") windSpeed = parseFloat(item.obsrValue); // 풍속(m/s)
    }

    console.log(
      `[기상청 데이터 성공] 기온: ${temp}°C, 습도: ${humidity}%, 풍속: ${windSpeed}m/s`,
    );
    return { temp, humidity, windSpeed };
  } catch (err) {
    console.log(`[기상청 API 실패] ${err.message} → 기본값 사용`);
    return { temp: null, humidity: null, windSpeed: null };
  }
}

// ── 체감온도 계산 ──
function calcFeelsLike(temp, humidity, windSpeed) {
  if (temp === null) return null;

  // 여름: 열지수 (Heat Index) — 기온 27도 이상
  if (temp >= 27 && humidity !== null) {
    const T = temp;
    const R = humidity;
    const hi =
      -8.7847 +
      1.6114 * T +
      ((2.3385 * R) / 100) * 10 -
      ((0.1461 * T * R) / 100) * 10;
    return Math.round(hi * 10) / 10;
  }

  // 겨울: 풍속냉각지수 (Wind Chill) — 기온 10도 이하, 풍속 1.3m/s 이상
  if (temp <= 10 && windSpeed !== null && windSpeed >= 1.3) {
    const wc =
      13.12 +
      0.6215 * temp -
      11.37 * Math.pow(windSpeed * 3.6, 0.16) +
      0.3965 * temp * Math.pow(windSpeed * 3.6, 0.16);
    return Math.round(wc * 10) / 10;
  }

  return temp;
}

// ── 기상 위험도 판단 ──
function assessWeatherRisk(temp, humidity, feelsLike) {
  if (temp === null)
    return { level: "unknown", message: "기상 데이터를 가져올 수 없습니다." };

  // 극한 고온 (체감온도 35도 이상)
  if (feelsLike >= 35)
    return {
      level: "danger",
      message: `체감온도 ${feelsLike}°C — 열사병 위험. 야외 활동을 금지합니다.`,
    };
  // 고온 주의 (체감온도 31도 이상)
  if (feelsLike >= 31)
    return {
      level: "warning",
      message: `체감온도 ${feelsLike}°C — 고온 주의. 활동 시간을 단축하세요.`,
    };
  // 극한 저온 (체감온도 -10도 이하)
  if (feelsLike <= -10)
    return {
      level: "danger",
      message: `체감온도 ${feelsLike}°C — 동상·저체온 위험. 실내 활동으로 대체하세요.`,
    };
  // 저온 주의 (체감온도 0도 이하)
  if (feelsLike <= 0)
    return {
      level: "warning",
      message: `체감온도 ${feelsLike}°C — 한파 주의. 방한 후 짧은 활동을 권장합니다.`,
    };
  // 높은 습도 (85% 이상 + 기온 28도 이상)
  if (humidity >= 85 && temp >= 28)
    return {
      level: "warning",
      message: `습도 ${humidity}%로 열 발산이 어렵습니다. 수분 섭취를 늘리세요.`,
    };

  return { level: "safe", message: "기상 조건이 활동에 적합합니다." };
}

// ── 동적 추천 골든타임 산출 ──
function calculateGoldenTime(temp, feelsLike, weatherRisk) {
  const currentTemp = feelsLike !== null ? feelsLike : temp;

  if (weatherRisk === "danger" || currentTemp >= 33) {
    return {
      time: "야외 활동 금지 (실내 대체 권장)",
      reason: "극심한 고온/위험 날씨로 인한 온열질환 위험",
      icon: "🚫",
    };
  }

  // 고온기 (체감온도 27도 이상)
  if (currentTemp >= 27) {
    return {
      time: "07:00 ~ 08:30 또는 19:30 ~ 20:30",
      reason: "직사광선과 지열을 피한 선선한 아침/해 진 후 저녁",
      icon: "🌅",
    };
  }

  // 저온기 (체감온도 10도 이하)
  if (currentTemp <= 10) {
    return {
      time: "13:00 ~ 15:00",
      reason: "하루 중 가장 따뜻한 낮 시간대 (혈관 급격 수축 예방)",
      icon: "☀️",
    };
  }

  // 온화한 기온 (11 ~ 26도)
  return {
    time: "09:30 ~ 11:00 또는 16:30 ~ 18:00",
    reason: "야외 유산소 신체활동 최적 시간",
    icon: "🌤️",
  };
}

// ── 메인 API 엔드포인트 ──
app.get("/api/health-status", async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat) || 37.5665;
    const lon = parseFloat(req.query.lon) || 126.978;

    console.log(
      `\n========== [Health-Status API 호출] 위도: ${lat}, 경도: ${lon} ==========`,
    );

    // 1) 날씨 데이터 조회 (측정소 탐색은 안정성 문제로 기본값 사용)
    const weather = await getWeatherData(lat, lon);
    const stationName = "종로구"; // 측정소 탐색 API 403 이슈로 기본값 고정

    // 2) 에어코리아 대기오염 데이터
    let pm10 = 25,
      pm25 = 12,
      caiGrade = "1";
    let airDataSuccess = false;
    try {
      console.log(`[에어코리아 API 요청] 측정소: ${stationName}`);
      const airResponse = await axios.get(
        `${AIR_API_URL}?serviceKey=${encodeURIComponent(RAW_KEY)}`,
        {
          params: {
            returnType: "json",
            numOfRows: "1",
            pageNo: "1",
            stationName: stationName,
            dataTerm: "DAILY",
            ver: "1.0",
          },
          timeout: 15000,
        },
      );

      const body = airResponse.data.response.body;
      const item = body.items[0];

      pm10 = parseInt(item.pm10Value) || 25;
      pm25 = parseInt(item.pm25Value) || 12;
      caiGrade = item.khaiGrade || item.kaiGrade || "1";

      console.log(
        `[대기오염 데이터 성공] PM10: ${pm10}㎍/㎥, PM2.5: ${pm25}㎍/㎥, 등급: ${caiGrade}`,
      );
    } catch (airErr) {
      console.log(`[에어코리아 API 실패] ${airErr.message} → 기본값 사용`);
    }

    // 4) 체감온도 계산
    const feelsLike = calcFeelsLike(
      weather.temp,
      weather.humidity,
      weather.windSpeed,
    );
    const temp = weather.temp !== null ? weather.temp : 22;
    const humidity = weather.humidity !== null ? weather.humidity : 50;

    // 5) 기상 위험도
    const weatherRisk = assessWeatherRisk(temp, humidity, feelsLike);

    // 6) 대기오염 위험도
    let airStatus = "safe";
    let airMessage = "";
    if (pm25 > 75 || caiGrade === "4") {
      airStatus = "danger";
      airMessage = `초미세먼지 ${pm25}㎍/㎥ (매우나쁨) — 심혈관 환자 위험 수치. 야외 활동을 금지합니다.`;
    } else if (pm25 > 35 || caiGrade === "3") {
      airStatus = "warning";
      airMessage = `초미세먼지 ${pm25}㎍/㎥ (나쁨) — 장시간 야외 운동 시 호흡기 자극 우려.`;
    } else if (pm25 > 15) {
      airStatus = "safe";
      airMessage = `초미세먼지 ${pm25}㎍/㎥ (보통) — 일반 활동 가능.`;
    } else {
      airStatus = "safe";
      airMessage = `초미세먼지 ${pm25}㎍/㎥ (좋음) — 호흡기에 무리 없는 최적 상태.`;
    }

    // 7) 종합 판단 (더 나쁜 쪽 기준)
    const levels = { safe: 0, warning: 1, danger: 2, unknown: 0 };
    const overallLevel =
      levels[weatherRisk.level] >= levels[airStatus]
        ? weatherRisk.level
        : airStatus;

    let badge, title, sub;
    if (overallLevel === "danger") {
      badge = "🔴 활동 제한";
      title = "오늘은 야외 활동을 삼가세요";
      sub = "실내 스트레칭이나 가벼운 체조로 대체하세요.";
    } else if (overallLevel === "warning") {
      badge = "🟠 주의 필요";
      title = "야외 활동 시 주의가 필요합니다";
      sub = "활동 시간을 줄이고 컨디션을 수시로 확인하세요.";
    } else {
      badge = "🟢 활동 원활";
      title = "야외 유산소 활동을 하기 아주 좋은 조건입니다";
      sub = "목표 심박수 범위를 유지하며 편안하게 걸어보세요.";
    }

    // PM10 등급 문자
    let pm10Grade = "좋음";
    if (pm10 > 150) pm10Grade = "매우나쁨";
    else if (pm10 > 80) pm10Grade = "나쁨";
    else if (pm10 > 30) pm10Grade = "보통";

    // PM2.5 등급 문자
    let pm25Grade = "좋음";
    if (pm25 > 75) pm25Grade = "매우나쁨";
    else if (pm25 > 35) pm25Grade = "나쁨";
    else if (pm25 > 15) pm25Grade = "보통";

    // 종합 reason (환경 분석 근거)
    const reason = [
      `📍 측정소: ${stationName}`,
      `🌡 기상: ${weatherRisk.message}`,
      `💨 대기: ${airMessage}`,
    ].join("\n");

    // 8) 추천 골든타임 동적 산출
    const goldenTimeInfo = calculateGoldenTime(
      temp,
      feelsLike,
      weatherRisk.level,
    );

    const responseData = {
      // 메인 상태
      status: overallLevel,
      badge,
      title,
      sub,
      // 환경 근거 상세
      reason,
      stationName,
      // 기상 데이터
      temp: temp.toFixed(1),
      feelsLike: feelsLike !== null ? feelsLike.toFixed(1) : temp.toFixed(1),
      humidity: Math.round(humidity),
      windSpeed:
        weather.windSpeed !== null ? weather.windSpeed.toFixed(1) : "-",
      weatherRisk: weatherRisk.level,
      weatherMessage: weatherRisk.message,
      // 추천 골든타임
      goldenTime: goldenTimeInfo.time,
      goldenTimeReason: goldenTimeInfo.reason,
      goldenTimeIcon: goldenTimeInfo.icon,
      // 대기오염 데이터
      pm10: `${pm10}㎍/㎥ (${pm10Grade})`,
      pm25: `${pm25}㎍/㎥ (${pm25Grade})`,
      pm10Value: pm10,
      pm25Value: pm25,
      airStatus,
      airMessage,
      // 데이터 출처
      dataSource: "에어코리아 실시간 + 기상청 초단기실황",
      updatedAt: new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
    };

    console.log(
      `[종합 판단] ${badge} — 기상: ${weatherRisk.level}, 대기: ${airStatus}`,
    );
    res.json(responseData);
  } catch (err) {
    console.error("[API 에러]:", err.message);
    res.json({
      status: "safe",
      badge: "🟢 활동 원활",
      title: "야외 유산소 활동을 하기 좋은 조건입니다",
      sub: "목표 심박수 범위를 유지하며 편안하게 걸어보세요.",
      reason:
        "📍 측정소: 종로구 (기본값)\n🌡 기상: 데이터 연결 중 — 기본 안전 판정\n💨 대기: 데이터 연결 중 — 기본 안전 판정",
      stationName: "종로구",
      temp: "22.0",
      feelsLike: "22.0",
      humidity: 50,
      windSpeed: "-",
      weatherRisk: "unknown",
      weatherMessage: "API 연결 중입니다.",
      goldenTime: "09:30 ~ 11:00 또는 16:30 ~ 18:00",
      goldenTimeReason: "쾌적한 야외 활동 기본 시간대",
      goldenTimeIcon: "🌤️",
      pm10: "보통",
      pm25: "보통",
      pm10Value: 30,
      pm25Value: 15,
      airStatus: "safe",
      airMessage: "기본 안전 데이터가 적용됩니다.",
      dataSource: "기본값 (API 연결 대기)",
      updatedAt: new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
    });
  }
});

app.listen(PORT, () => {
  console.log(`Heart-Fit Server running at http://localhost:${PORT}`);
});
