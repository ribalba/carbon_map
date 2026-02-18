FROM nginx:1.27-alpine

WORKDIR /usr/share/nginx/html

COPY index.html ./
COPY app.js ./
COPY styles.css ./
COPY country_country_rtt.csv ./

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
