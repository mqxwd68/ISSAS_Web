import cv2
import numpy as np
import sys
import os
import traceback
from PIL import Image


def hsl_to_rgb(h, s, l):
    """将HSL颜色转换为RGB颜色"""
    h = h / 360.0
    s = s / 100.0
    l = l / 100.0

    if s == 0:
        r = g = b = l
    else:
        def hue_to_rgb(p, q, t):
            if t < 0: t += 1
            if t > 1: t -= 1
            if t < 1 / 6: return p + (q - p) * 6 * t
            if t < 1 / 2: return q
            if t < 2 / 3: return p + (q - p) * (2 / 3 - t) * 6
            return p

        q = l * (1 + s) if l < 0.5 else l + s - l * s
        p = 2 * l - q
        r = hue_to_rgb(p, q, h + 1 / 3)
        g = hue_to_rgb(p, q, h)
        b = hue_to_rgb(p, q, h - 1 / 3)

    return int(r * 255), int(g * 255), int(b * 255)


def extract_boundaries_from_png(png_path, txt_path):
    """从PNG掩码中提取边界点并生成YOLO格式TXT - 直接推断原始类别ID"""
    try:
        # 加载调色板PNG图像
        pil_img = Image.open(png_path)

        # 获取图像的实际模式
        print(f"Original image mode: {pil_img.mode}")

        # 获取调色板信息
        if pil_img.mode == 'P':
            # 获取调色板数据
            palette = pil_img.getpalette()
            palette_array = np.array(palette[:768]).reshape(-1, 3)

            # 获取原始索引数据
            index_data = np.array(pil_img.getdata(), dtype=np.uint8).reshape(pil_img.size[::-1])
            h, w = index_data.shape
        else:
            # 如果不是调色板模式，转换为索引模式
            pil_img = pil_img.convert('P')
            palette = pil_img.getpalette()
            palette_array = np.array(palette[:768]).reshape(-1, 3)
            index_data = np.array(pil_img.getdata(), dtype=np.uint8).reshape(pil_img.size[::-1])
            h, w = index_data.shape

        # 创建颜色到类别ID的映射
        color_to_class = {}
        # 预计算所有可能的类别ID颜色
        class_id_colors = {}
        for class_id in range(1, 256):
            hue = (class_id * 77) % 360
            s_val = 85 + (class_id % 15)
            l_val = 55 + (class_id % 10)
            class_id_colors[class_id] = hsl_to_rgb(hue, s_val, l_val)

        # 创建结果文件
        with open(txt_path, 'w') as f:
            # 获取所有唯一的索引值（排除背景0）
            indices = np.unique(index_data)

            for idx in indices:
                if idx == 0:  # 跳过背景
                    continue

                # 获取该索引对应的颜色
                color = tuple(palette_array[idx])

                # 尝试找到匹配的颜色
                best_class_id = None
                best_dist = float('inf')

                for class_id, target_color in class_id_colors.items():
                    # 计算颜色距离
                    dist = sum((c1 - c2) ** 2 for c1, c2 in zip(color, target_color)) ** 0.5
                    if dist < best_dist:
                        best_dist = dist
                        best_class_id = class_id

                # 如果找到合理的匹配（距离小于阈值）
                if best_dist < 5:
                    class_id = best_class_id
                else:
                    # 如果没有找到好的匹配，使用索引值作为类别ID
                    class_id = idx
                    print(f"Warning: Using index as class ID for color {color} (distance {best_dist:.2f})")

                # 创建当前索引值的二值掩码
                mask = (index_data == idx).astype(np.uint8) * 255

                # 找到轮廓
                contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_TC89_KCOS)

                # 处理每个轮廓
                for contour in contours:
                    # 简化轮廓点
                    epsilon = 0.001 * cv2.arcLength(contour, True)
                    approx = cv2.approxPolyDP(contour, epsilon, True)

                    # 确保是多边形
                    if len(approx) >= 3:
                        # 归一化坐标
                        line = f"{class_id}"
                        for point in approx:
                            x, y = point[0]
                            norm_x = x / w
                            norm_y = y / h
                            line += f" {norm_x:.6f} {norm_y:.6f}"
                        f.write(line + "\n")

        print(f"Successfully generated YOLO annotations at {txt_path}")
        return True

    except Exception as e:
        print(f"Error in extracting boundaries: {str(e)}")
        traceback.print_exc()
        return False


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python generate_yolo_from_png.py <png_path> <txt_path>")
        sys.exit(1)

    png_path = sys.argv[1]
    txt_path = sys.argv[2]

    if not os.path.exists(png_path):
        print(f"Error: PNG file not found at {png_path}")
        sys.exit(1)

    success = extract_boundaries_from_png(png_path, txt_path)
    sys.exit(0 if success else 1)