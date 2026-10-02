<?php
/** Visual layer only: leaves authentication, message rendering and navigation intact. */
class mailway_theme extends rcube_plugin
{
    public function init()
    {
        if (rcmail::get_instance()->config->get('skin') === 'elastic') {
            $this->include_stylesheet('mailway.css');
        }
    }
}
