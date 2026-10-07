#!/usr/bin/env bash
# Quick dashboard script to inspect Thumbview study telemetry in PostgreSQL on precision.usask.ca.
# Usage:
#   ./view_data.sh           # View overview dashboard (counts, participants, recent episodes)
#   ./view_data.sh -p        # List all participants
#   ./view_data.sh -e        # List recent episodes (visits)
#   ./view_data.sh -s        # List recent sessions
#   ./view_data.sh -r        # List raw events
#   ./view_data.sh -n        # Show recent Nginx client IP logs

set -e

DB_NAME="thumbview_study"

# Check if we should use sudo -u postgres or standard psql
if command -v sudo >/dev/null 2>&1 && sudo -n -u postgres psql -d "$DB_NAME" -c "SELECT 1;" >/dev/null 2>&1; then
    PSQL_CMD="sudo -u postgres psql -d $DB_NAME"
elif psql -U thumbview_user -d "$DB_NAME" -h localhost -c "SELECT 1;" >/dev/null 2>&1; then
    PSQL_CMD="psql -U thumbview_user -d $DB_NAME -h localhost"
elif command -v sudo >/dev/null 2>&1; then
    PSQL_CMD="sudo -u postgres psql -d $DB_NAME"
else
    PSQL_CMD="psql -d $DB_NAME"
fi

print_header() {
    echo -e "\033[1;36m========================================================================\033[0m"
    echo -e "\033[1;32m  $1\033[0m"
    echo -e "\033[1;36m========================================================================\033[0m"
}

show_counts() {
    print_header "Thumbview Telemetry Summary Counts"
    $PSQL_CMD -c "
        SELECT 
            (SELECT count(*) FROM participants) AS participants,
            (SELECT count(*) FROM sessions) AS sessions,
            (SELECT count(*) FROM episodes) AS episodes,
            (SELECT count(*) FROM opens) AS opens,
            (SELECT count(*) FROM editor_switches) AS switches,
            (SELECT count(*) FROM raw_events) AS raw_events;
    "
}

show_participants() {
    print_header "Participants (Enrolled)"
    $PSQL_CMD -c "
        SELECT 
            participant_id, 
            to_char(enrolled_at, 'YYYY-MM-DD HH24:MI:SS') AS enrolled_at,
            platform, 
            vscode_version, 
            ext_version
        FROM participants
        ORDER BY enrolled_at DESC;
    "
}

show_sessions() {
    print_header "Recent Sessions (Started vs Received)"
    $PSQL_CMD -c "
        SELECT 
            participant_id,
            to_char(started_at, 'YYYY-MM-DD HH24:MI') AS client_started,
            to_char(received_at, 'YYYY-MM-DD HH24:MI') AS server_received,
            layout_mode,
            fullscreen_on_open AS fullscreen,
            workspace_folders AS folders
        FROM sessions
        ORDER BY received_at DESC
        LIMIT 10;
    "
}

show_episodes() {
    print_header "Recent Episodes (Thumbview Visits)"
    $PSQL_CMD -c "
        SELECT 
            participant_id,
            to_char(ts, 'YYYY-MM-DD HH24:MI:SS') AS visit_time,
            outcome,
            interaction_method AS method,
            time_to_target_ms AS time_ms,
            search_used AS search,
            file_count AS files
        FROM episodes
        ORDER BY ts DESC
        LIMIT 10;
    "
}

show_raw() {
    print_header "Recent Raw Events Stream"
    $PSQL_CMD -c "
        SELECT 
            id,
            participant_id,
            event,
            to_char(ts, 'YYYY-MM-DD HH24:MI:SS') AS ts,
            to_char(received_at, 'YYYY-MM-DD HH24:MI:SS') AS received_at
        FROM raw_events
        ORDER BY id DESC
        LIMIT 15;
    "
}

show_nginx_ips() {
    print_header "Recent Incoming Client IPs (Nginx Access Log)"
    if [ -f /var/log/nginx/access.log ]; then
        if [ -r /var/log/nginx/access.log ] || command -v sudo >/dev/null 2>&1; then
            sudo grep -E '/study/api/(events|participant-id)' /var/log/nginx/access.log 2>/dev/null | awk '{print $1, $4, $7, $9}' | tail -n 15 || true
        fi
    else
        echo "Nginx access log not found at /var/log/nginx/access.log"
    fi
}

case "$1" in
    -p|--participants)
        show_participants
        ;;
    -e|--episodes)
        show_episodes
        ;;
    -s|--sessions)
        show_sessions
        ;;
    -r|--raw)
        show_raw
        ;;
    -n|--ips)
        show_nginx_ips
        ;;
    *)
        show_counts
        echo ""
        show_participants
        echo ""
        show_episodes
        echo ""
        show_nginx_ips
        echo ""
        echo -e "\033[0;33mTip: Run '$0 -p' for all participants, '$0 -e' for episodes, '$0 -r' for raw events, '$0 -n' for client IPs.\033[0m"
        ;;
esac
