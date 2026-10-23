# cloud-link: the robot's link to Spiri Cloud, and its SpiriConfig page.
# Standard library only, plus segno for the QR code, so the page needs
# nothing from the internet but the cloud itself.
FROM python:3.13-slim
RUN pip install --no-cache-dir segno==1.6.6
COPY link.py /opt/cloud-link/
COPY web /opt/cloud-link/web
ENTRYPOINT ["python3", "-u", "/opt/cloud-link/link.py"]
