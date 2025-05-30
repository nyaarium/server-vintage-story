FROM debian:bookworm


# Adjust the game version here
ENV GAME_VERSION="1.20.11"


ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=America/Los_Angeles
ENV LANGUAGE=en_US:en
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV HOME=/root

RUN apt update && apt install -y \
	software-properties-common \
	&& apt autoremove --purge -y && apt clean

RUN apt update && apt install -y \
	ca-certificates \
	curl \
	gnupg \
	screen \
	wget \
	locales \
	&& sed -i -e 's/# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
	&& locale-gen \
	&& update-locale LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
	&& apt autoremove --purge -y && apt clean

RUN NODE_MAJOR=22 \
	&& curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
	&& echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
	&& apt update \
	&& apt install -y nodejs \
	&& apt clean && rm -rf /var/lib/apt/lists/*


############################
# App dependencies

RUN wget https://dot.net/v1/dotnet-install.sh -O dotnet-install.sh \
	&& chmod +x dotnet-install.sh \
	&& ./dotnet-install.sh --runtime aspnetcore --channel 7.0 \
	&& apt autoremove --purge -y && apt clean


############################
# Game server

COPY install.sh /root/install.sh
RUN chmod +x /root/install.sh \
	&& /root/install.sh \
	&& rm /root/install.sh


############################
# Monitor server

COPY monitor/ /monitor/
RUN cd /monitor \
	&& npm i express helmet moment moment-timezone


############################
# Mod updater

COPY mod-updater.mjs /root/mod-updater.mjs
RUN cd /root \
	&& npm i cheerio discord.js json5 moment moment-timezone node-fetch


############################
# Docker server

COPY start-docker-server.sh /app/start-docker-server.sh
RUN chmod +x /app/start-docker-server.sh

WORKDIR /app
CMD ["/app/start-docker-server.sh"]
