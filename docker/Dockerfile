FROM debian:bookworm


# Adjust the game version here
ENV GAME_VERSION="1.20.4"


ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=America/Los_Angeles
ENV LANGUAGE=en_US:en
ENV LC_ALL=C

RUN apt update && apt install -y \
	software-properties-common \
	&& apt autoremove --purge -y && apt clean

RUN apt update && apt install -y \
	ca-certificates \
	curl \
	gnupg \
	screen \
	wget \
	&& apt autoremove --purge -y && apt clean

RUN wget https://dot.net/v1/dotnet-install.sh -O dotnet-install.sh \
	&& chmod +x dotnet-install.sh \
	&& ./dotnet-install.sh --runtime aspnetcore --channel 7.0 \
	&& apt autoremove --purge -y && apt clean

RUN NODE_MAJOR=22 \
	&& curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
	&& echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
	&& apt update \
	&& apt install -y nodejs \
	&& apt clean && rm -rf /var/lib/apt/lists/*

RUN cd /root && npm i json5 node-fetch cheerio moment moment-timezone discord.js

COPY install.sh /root/install.sh
RUN chmod +x /root/install.sh \
	&& /root/install.sh \
	&& rm /root/install.sh

COPY start-docker-server.sh /app/start-docker-server.sh
RUN chmod +x /app/start-docker-server.sh

COPY monitor/ /monitor/
RUN cd /monitor/ \
	&& chmod +x *.sh \
	&& npm i

COPY mod-updater.mjs /root/mod-updater.mjs

WORKDIR /app
CMD ["/app/start-docker-server.sh"]
