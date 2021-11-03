>docker build -t owl-img --no-cache https://github.com/gianlucacannilla/openwhisk-light.git

>docker network create owl-net

>docker network inspect owl-net

>docker -H tcp://172.19.0.1:2375 info

>docker run -d --net=owl-net -p 3000:3000 -e DOCKER_HOST=tcp://172.19.0.1:2375 -e  OWL_NEXT_OPENWHISK=https://192.168.1.10:31001  --name owl owl-img

> docker logs owl