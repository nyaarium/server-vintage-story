FROM ubuntu:noble


# Adjust the game version here
ENV GAME_VERSION="1.22.0"


RUN apt update -qq && apt install -qq -y locales tzdata ca-certificates && apt clean -y && rm -rf /var/lib/apt/lists/* \
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
    && locale-gen en_US.UTF-8 \
    && update-locale LANG=en_US.UTF-8 \
    && ln -fs /usr/share/zoneinfo/America/Los_Angeles /etc/localtime \
    && echo "America/Los_Angeles" > /etc/timezone
ENV LANGUAGE=en_US:en
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
	unzip \
	wget \
	&& apt autoremove --purge -y && apt clean

# Node.js
RUN NODE_MAJOR=24 \
	&& curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
	&& echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
	&& apt update -qq && apt install -qq -y nodejs \
	&& npm install -g npm@latest --loglevel=warn \
	&& npm config set -g update-notifier false \
	&& corepack enable \
	&& corepack prepare yarn@stable --activate \
	&& rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/keyrings/nodesource.gpg \
	&& apt clean && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash


############################
# App dependencies

RUN wget https://dot.net/v1/dotnet-install.sh -O dotnet-install.sh \
	&& chmod +x dotnet-install.sh \
	&& ./dotnet-install.sh --runtime dotnet --channel 10.0 \
	&& apt autoremove --purge -y && apt clean


############################
# Game server

COPY docker/install.sh /root/install.sh
RUN chmod +x /root/install.sh \
	&& /root/install.sh \
	&& rm /root/install.sh


############################
# Mod updater

COPY docker/mod-updater/package.json docker/mod-updater/bun.lock /root/mod-updater/
RUN cd /root/mod-updater && /root/.bun/bin/bun install --production --frozen-lockfile
COPY docker/mod-updater/ /root/mod-updater/


############################
# Server start script

COPY docker/start-server.sh /app/start-server.sh
RUN chmod +x /app/start-server.sh

WORKDIR /app
CMD ["sleep", "infinity"]
