"""Escapes text for a GitHub Actions workflow command (::error::...).

Text from the game's API or the spreadsheets is written by strangers: a newline
followed by "::" in it would start a second command in the log. The checks print
every such message through escape().
"""


def escape(text):
    return str(text).replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
