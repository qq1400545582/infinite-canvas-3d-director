/**
 * 极简二维码编码器（零依赖，byte 模式 / UTF-8），只用于在支付页画二维码。
 *
 * 为什么自己写：授权服务要保持 `node src/index.js` 直接可跑（无构建、无 npm 安装），
 * 部署到边缘平台时也只需要拷 src 目录。二维码本身是确定性算法，实现一次即可。
 *
 * 覆盖范围：版本 1–40 自动选择（按内容长度）、纠错等级默认 M、8 种掩码自动择优。
 * 输出为 SVG 字符串，可直接塞进 data:image/svg+xml 或内联渲染。
 */

const ECL = { L: 0, M: 1, Q: 2, H: 3 };

/** 格式信息里的纠错等级编码（L=01, M=00, Q=11, H=10）。 */
const ECL_FORMAT_BITS = [1, 0, 3, 2];

/** 每个版本的总码字数（含纠错码字）。 */
const TOTAL_CODEWORDS = [
    0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991,
    1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876,
    3034, 3196, 3362, 3532, 3706,
];

/** 每个版本、每个纠错等级的纠错码字总数。列顺序 L, M, Q, H。 */
const EC_CODEWORDS = [
    [7, 10, 13, 17],
    [10, 16, 22, 28],
    [15, 26, 36, 44],
    [20, 36, 52, 64],
    [26, 48, 72, 88],
    [36, 64, 96, 112],
    [40, 72, 108, 130],
    [48, 88, 132, 156],
    [60, 110, 160, 192],
    [72, 130, 192, 224],
    [80, 150, 224, 264],
    [96, 176, 260, 308],
    [104, 198, 288, 352],
    [120, 216, 320, 384],
    [132, 240, 360, 432],
    [144, 280, 408, 480],
    [168, 308, 448, 532],
    [180, 338, 504, 588],
    [196, 364, 546, 650],
    [224, 416, 600, 700],
    [224, 442, 644, 750],
    [252, 476, 690, 816],
    [270, 504, 750, 900],
    [300, 560, 810, 960],
    [312, 588, 870, 1050],
    [336, 644, 952, 1110],
    [360, 700, 1020, 1200],
    [390, 728, 1050, 1260],
    [420, 784, 1140, 1350],
    [450, 812, 1200, 1440],
    [480, 868, 1290, 1530],
    [510, 924, 1350, 1620],
    [540, 980, 1440, 1710],
    [570, 1036, 1530, 1800],
    [570, 1064, 1590, 1890],
    [600, 1120, 1680, 1980],
    [630, 1204, 1770, 2100],
    [660, 1260, 1860, 2220],
    [720, 1316, 1950, 2310],
    [750, 1372, 2040, 2430],
];

/** 每个版本、每个纠错等级的分块数。列顺序 L, M, Q, H。 */
const BLOCK_COUNT = [
    [1, 1, 1, 1],
    [1, 1, 1, 1],
    [1, 1, 2, 2],
    [1, 2, 2, 4],
    [1, 2, 4, 4],
    [2, 4, 4, 4],
    [2, 4, 6, 5],
    [2, 4, 6, 6],
    [2, 5, 8, 8],
    [4, 5, 8, 8],
    [4, 5, 8, 11],
    [4, 8, 10, 11],
    [4, 9, 12, 16],
    [4, 9, 16, 16],
    [6, 10, 12, 18],
    [6, 10, 17, 16],
    [6, 11, 16, 19],
    [6, 13, 18, 21],
    [7, 14, 21, 25],
    [8, 16, 20, 25],
    [8, 17, 23, 25],
    [9, 17, 23, 34],
    [9, 18, 25, 30],
    [10, 20, 27, 32],
    [12, 21, 29, 35],
    [12, 23, 34, 37],
    [12, 25, 34, 40],
    [13, 26, 35, 42],
    [14, 28, 38, 45],
    [15, 29, 40, 48],
    [16, 31, 43, 51],
    [17, 33, 45, 54],
    [18, 35, 48, 57],
    [19, 37, 51, 60],
    [19, 38, 53, 63],
    [20, 40, 56, 66],
    [21, 43, 59, 70],
    [22, 45, 62, 74],
    [24, 47, 65, 77],
    [25, 49, 68, 81],
];

function getBit(value, index) {
    return ((value >>> index) & 1) !== 0;
}

function symbolSize(version) {
    return version * 4 + 17;
}

function dataCapacityBits(version, ecl) {
    return (TOTAL_CODEWORDS[version] - EC_CODEWORDS[version - 1][ecl]) * 8;
}

/* ---------------- GF(256) 与 Reed-Solomon ---------------- */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGaloisField() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        GF_EXP[i] = x;
        GF_LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMultiply(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** 生成多项式：degree 次的除数，系数按降幂排列（最高次隐含为 1）。 */
function rsDivisor(degree) {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
            result[j] = gfMultiply(result[j], root);
            if (j + 1 < degree) result[j] ^= result[j + 1];
        }
        root = gfMultiply(root, 0x02);
    }
    return result;
}

function rsRemainder(data, divisor) {
    const result = new Uint8Array(divisor.length);
    for (const byte of data) {
        const factor = byte ^ result[0];
        result.copyWithin(0, 1);
        result[result.length - 1] = 0;
        for (let i = 0; i < result.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
    }
    return result;
}

/* ---------------- 数据编码 ---------------- */

function pickVersion(byteLength, ecl) {
    for (let version = 1; version <= 40; version++) {
        const countBits = version <= 9 ? 8 : 16;
        if (4 + countBits + byteLength * 8 <= dataCapacityBits(version, ecl)) return version;
    }
    throw new Error("内容过长，无法生成二维码");
}

function buildDataCodewords(bytes, version, ecl) {
    const bits = [];
    const push = (value, length) => {
        for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };

    push(0b0100, 4); // byte 模式
    push(bytes.length, version <= 9 ? 8 : 16);
    for (const byte of bytes) push(byte, 8);

    const capacity = dataCapacityBits(version, ecl);
    push(0, Math.min(4, capacity - bits.length)); // 结束符
    while (bits.length % 8 !== 0) bits.push(0);

    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
        let value = 0;
        for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
        codewords.push(value);
    }
    const target = capacity / 8;
    for (let i = 0; codewords.length < target; i++) codewords.push(i % 2 === 0 ? 0xec : 0x11);
    return codewords;
}

/** 分块 → 计算纠错码 → 交织（QR 规定的顺序）。 */
function interleave(data, version, ecl) {
    const blocks = BLOCK_COUNT[version - 1][ecl];
    const ecTotal = EC_CODEWORDS[version - 1][ecl];
    const total = TOTAL_CODEWORDS[version];
    const dataTotal = total - ecTotal;

    const blocksInGroup2 = total % blocks;
    const blocksInGroup1 = blocks - blocksInGroup2;
    const perBlockTotal = Math.floor(total / blocks);
    const perBlockData = Math.floor(dataTotal / blocks);
    const ecPerBlock = perBlockTotal - perBlockData;

    const divisor = rsDivisor(ecPerBlock);
    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    for (let i = 0; i < blocks; i++) {
        const length = i < blocksInGroup1 ? perBlockData : perBlockData + 1;
        const chunk = data.slice(offset, offset + length);
        offset += length;
        dataBlocks.push(chunk);
        ecBlocks.push(rsRemainder(chunk, divisor));
    }

    const result = [];
    const maxData = Math.max(...dataBlocks.map((block) => block.length));
    for (let i = 0; i < maxData; i++) {
        for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
    }
    for (let i = 0; i < ecPerBlock; i++) {
        for (const block of ecBlocks) result.push(block[i]);
    }
    return result;
}

/* ---------------- 矩阵绘制 ---------------- */

const MASK_FUNCTIONS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** 对齐图案的中心坐标（一半，靠对称补全）。 */
function alignmentCoords(version) {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const size = symbolSize(version);
    const step = size === 145 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
    const result = [size - 7];
    for (let i = 1; i < count - 1; i++) result[i] = result[i - 1] - step;
    result.push(6);
    return result.reverse();
}

function createMatrix(version, ecl, codewords) {
    const size = symbolSize(version);
    const modules = new Int8Array(size * size).fill(0);
    const isFunction = new Uint8Array(size * size);

    const set = (x, y, dark) => {
        modules[y * size + x] = dark ? 1 : 0;
        isFunction[y * size + x] = 1;
    };

    // 定时图案（先画，被后面 finder 覆盖边缘）
    for (let i = 0; i < size; i++) {
        set(6, i, i % 2 === 0);
        set(i, 6, i % 2 === 0);
    }

    const drawFinder = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const x = cx + dx;
                const y = cy + dy;
                if (x < 0 || y < 0 || x >= size || y >= size) continue;
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                set(x, y, dist !== 2 && dist !== 4);
            }
        }
    };
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);

    const coords = alignmentCoords(version);
    for (const cy of coords) {
        for (const cx of coords) {
            // 与三个定位图案重叠的位置跳过
            if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
                }
            }
        }
    }

    // 只标记格式信息占位（真实值由 drawFormat 在选定掩码后写入）
    const markFormatAreas = () => {
        for (let i = 0; i <= 5; i++) set(8, i, false);
        set(8, 7, false);
        set(8, 8, false);
        set(7, 8, false);
        for (let i = 9; i < 15; i++) set(14 - i, 8, false);
        for (let i = 0; i < 8; i++) set(size - 1 - i, 8, false);
        for (let i = 8; i < 15; i++) set(8, size - 15 + i, false);
        set(8, size - 8, true); // 固定深色模块
    };

    const drawVersionBits = () => {
        if (version < 7) return;
        let remainder = version;
        for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
        const bits = (version << 12) | remainder;
        for (let i = 0; i < 18; i++) {
            const bit = getBit(bits, i);
            const a = size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            set(a, b, bit);
            set(b, a, bit);
        }
    };

    markFormatAreas();
    drawVersionBits();

    // 数据填充：从右下角开始，两列一组蛇形向上/向下
    let bitIndex = 0;
    const totalBits = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - vert : vert;
                if (isFunction[y * size + x] || bitIndex >= totalBits) continue;
                modules[y * size + x] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7)) ? 1 : 0;
                bitIndex++;
            }
        }
    }

    return { size, modules, isFunction };
}

function applyMask(matrix, mask) {
    const { size, modules, isFunction } = matrix;
    const fn = MASK_FUNCTIONS[mask];
    const out = new Int8Array(modules);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (!isFunction[y * size + x] && fn(x, y)) out[y * size + x] ^= 1;
        }
    }
    return out;
}

/** 标准四类罚分，用于挑选最优掩码。 */
function penaltyScore(modules, size) {
    let score = 0;
    const at = (x, y) => modules[y * size + x];

    // 规则 1：行/列连续同色 ≥ 5
    for (let y = 0; y < size; y++) {
        let run = 1;
        for (let x = 1; x < size; x++) {
            if (at(x, y) === at(x - 1, y)) run++;
            else {
                if (run >= 5) score += 3 + (run - 5);
                run = 1;
            }
        }
        if (run >= 5) score += 3 + (run - 5);
    }
    for (let x = 0; x < size; x++) {
        let run = 1;
        for (let y = 1; y < size; y++) {
            if (at(x, y) === at(x, y - 1)) run++;
            else {
                if (run >= 5) score += 3 + (run - 5);
                run = 1;
            }
        }
        if (run >= 5) score += 3 + (run - 5);
    }

    // 规则 2：2×2 同色块
    for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
            const v = at(x, y);
            if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
        }
    }

    // 规则 3：类似定位图案的 1:1:3:1:1 序列
    const patterns = [
        [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
        [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
    ];
    for (let y = 0; y < size; y++) {
        for (let x = 0; x <= size - 11; x++) {
            for (const pattern of patterns) {
                let hit = true;
                for (let k = 0; k < 11; k++) {
                    if (at(x + k, y) !== pattern[k]) {
                        hit = false;
                        break;
                    }
                }
                if (hit) score += 40;
            }
        }
    }
    for (let x = 0; x < size; x++) {
        for (let y = 0; y <= size - 11; y++) {
            for (const pattern of patterns) {
                let hit = true;
                for (let k = 0; k < 11; k++) {
                    if (at(x, y + k) !== pattern[k]) {
                        hit = false;
                        break;
                    }
                }
                if (hit) score += 40;
            }
        }
    }

    // 规则 4：深色比例偏离 50%
    let dark = 0;
    for (const value of modules) dark += value;
    const total = size * size;
    const deviation = Math.abs(dark * 20 - total * 10);
    score += Math.floor(deviation / total) * 10;

    return score;
}

/** 把格式信息（含掩码号）写进矩阵。功能模块标记同步更新。 */
function drawFormat(matrix, ecl, mask) {
    const { size, modules, isFunction } = matrix;
    const put = (x, y, dark) => {
        modules[y * size + x] = dark ? 1 : 0;
        isFunction[y * size + x] = 1;
    };

    const data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;

    for (let i = 0; i <= 5; i++) put(8, i, getBit(bits, i));
    put(8, 7, getBit(bits, 6));
    put(8, 8, getBit(bits, 7));
    put(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) put(14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i++) put(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) put(8, size - 15 + i, getBit(bits, i));
    put(8, size - 8, true);
}

/** 返回最终矩阵（已选掩码）。mask 传具体值时强制使用该掩码（自检用）。 */
function finalMatrix(text, options = {}) {
    const ecl = ECL[String(options.ecl || "M").toUpperCase()] ?? ECL.M;
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    const version = pickVersion(bytes.length, ecl);
    const codewords = interleave(buildDataCodewords(bytes, version, ecl), version, ecl);
    const masks = options.mask === undefined || options.mask === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [options.mask];

    let best = null;
    for (const mask of masks) {
        const base = createMatrix(version, ecl, codewords);
        const matrix = { version, size: base.size, modules: applyMask(base, mask), isFunction: base.isFunction };
        drawFormat(matrix, ecl, mask);
        const score = penaltyScore(matrix.modules, matrix.size);
        if (!best || score < best.score) best = { score, ...matrix, mask };
    }
    return best;
}

/**
 * 生成二维码 SVG 字符串。
 * @param {string} text 任意文本（UTF-8）
 * @param {{ecl?: "L"|"M"|"Q"|"H", margin?: number, dark?: string, light?: string, mask?: number}} options
 */
export function qrSvg(text, options = {}) {
    const { size, modules } = finalMatrix(text, options);
    const margin = options.margin === undefined ? 3 : options.margin;
    const dark = options.dark || "#000000";
    const light = options.light || "#ffffff";
    const dim = size + margin * 2;

    let path = "";
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (modules[y * size + x]) path += `M${x + margin},${y + margin}h1v1h-1z`;
        }
    }

    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges" role="img" aria-label="payment qrcode">` +
        `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
        `<path d="${path}" fill="${dark}"/>` +
        `</svg>`
    );
}

/** 生成可直接放进 <img src> 的 data URI。 */
export function qrDataUrl(text, options = {}) {
    return `data:image/svg+xml;base64,${Buffer.from(qrSvg(text, options), "utf8").toString("base64")}`;
}

/** 调试/自检用：拿到 0/1 矩阵。 */
export function qrMatrix(text, options = {}) {
    const result = finalMatrix(text, options);
    return { version: result.version, mask: result.mask, size: result.size, data: Array.from(result.modules) };
}
