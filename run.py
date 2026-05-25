import os
import socket

os.chdir(os.path.dirname(os.path.abspath(__file__)))


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


if __name__ == "__main__":
    import uvicorn

    ip = get_local_ip()
    print("\n" + "=" * 45)
    print("  去水印工具 已启动")
    print("=" * 45)
    print(f"  本机浏览器: http://localhost:8000")
    print(f"  手机访问  : http://{ip}:8000")
    print("  （手机与电脑需连接同一 Wi-Fi）")
    print("=" * 45 + "\n")

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
